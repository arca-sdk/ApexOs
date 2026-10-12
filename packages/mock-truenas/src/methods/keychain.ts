/**
 * `keychaincredential.*` (SSH key pairs and SSH connections) and the SSH service settings (`ssh.*`).
 *
 * Keys are simulated but shaped like real OpenSSH keys: a private key is an unencrypted
 * `openssh-key-v1` container that embeds its public key blob, so the public key can be derived from
 * the private one exactly as TrueNAS does with `ssh-keygen -y`.
 */
import { randomBytes } from 'node:crypto';
import type { Mock } from '../context.ts';
import { hostKeyLines, findPeer, keyIds } from '../peers.ts';
import { callError, queryFilter, validationError, validationErrors } from '../rpc.ts';
import { publicKeyLine, type KeychainCredentialState, type SshConfigState } from '../state.ts';
import { argObj, isObj, type Obj } from '../util.ts';

const MAGIC = Buffer.from('openssh-key-v1\0');

function sshString(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

function readString(buf: Buffer, offset: number): [Buffer, number] {
  const len = buf.readUInt32BE(offset);
  return [buf.subarray(offset + 4, offset + 4 + len), offset + 4 + len];
}

function pem(body: Buffer): string {
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n').trim();
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** A new RSA-style key pair, like `keychaincredential.generate_ssh_key_pair` (`ssh-keygen -t rsa`). */
export function generateKeyPair(comment: string): { private_key: string; public_key: string } {
  const pub = publicKeyLine('ssh-rsa', Buffer.concat([Buffer.from([0, 0, 0, 3, 1, 0, 1, 0, 0, 1, 1, 0]), randomBytes(256)]));
  const blob = Buffer.from(pub.split(' ')[1]!, 'base64');
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const body = Buffer.concat([MAGIC, sshString(Buffer.from('none')), sshString(Buffer.from('none')), sshString(Buffer.alloc(0)), count, sshString(blob), sshString(randomBytes(96))]);
  return { private_key: pem(body), public_key: `${pub} ${comment}\n` };
}

/** Public key line of an unencrypted OpenSSH private key, or null when it can't be read. */
export function publicKeyOf(privateKey: string): string | null {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(privateKey);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    let off = MAGIC.length;
    let cipher: Buffer;
    [cipher, off] = readString(buf, off);
    if (cipher.toString() !== 'none') return null; // encrypted keys are refused by TrueNAS as well
    [, off] = readString(buf, off); // kdfname
    [, off] = readString(buf, off); // kdfoptions
    off += 4; // number of keys
    const [blob] = readString(buf, off);
    const [type] = readString(blob, 0);
    return `${type.toString()} ${blob.toString('base64')}`;
  } catch {
    return null;
  }
}

export function renderCredential(c: KeychainCredentialState): Obj {
  return { id: c.id, name: c.name, type: c.type, attributes: structuredClone(c.attributes) };
}

function validateKeyPair(attrs: Obj, attr: string): Obj {
  const errors: Array<[string, string]> = [];
  const priv = typeof attrs.private_key === 'string' && attrs.private_key.trim() ? attrs.private_key : null;
  let pub = typeof attrs.public_key === 'string' && attrs.public_key.trim() ? attrs.public_key.trim() : null;
  if (priv) {
    const derived = publicKeyOf(priv);
    if (!derived) errors.push([`${attr}.private_key`, 'Load key "/tmp/key": invalid format']);
    else if (pub && keyIds(pub)[0] !== keyIds(derived)[0]) errors.push([`${attr}.public_key`, 'Private key and public key do not match']);
    else pub ??= derived;
  } else if (!pub) errors.push([`${attr}.public_key`, 'You must specify a key']);
  else if (!keyIds(pub).length) errors.push([`${attr}.public_key`, 'Invalid public key']);
  if (errors.length) throw validationErrors(errors);
  return { private_key: priv, public_key: pub };
}

function validateCredentials(mock: Mock, attrs: Obj, attr: string): Obj {
  const errors: Array<[string, string]> = [];
  if (typeof attrs.host !== 'string' || !attrs.host) errors.push([`${attr}.host`, 'Field required']);
  if (typeof attrs.private_key !== 'number') errors.push([`${attr}.private_key`, 'Field required']);
  else if (!mock.state.keychain.some((k) => k.id === attrs.private_key && k.type === 'SSH_KEY_PAIR' && k.attributes.private_key)) {
    errors.push([`${attr}.private_key`, 'This SSH key pair does not exist or has no private key']);
  }
  if (typeof attrs.remote_host_key !== 'string' || !attrs.remote_host_key) errors.push([`${attr}.remote_host_key`, 'Field required']);
  const port = attrs.port ?? 22;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) errors.push([`${attr}.port`, 'Input should be a valid port']);
  if (errors.length) throw validationErrors(errors);
  return {
    host: attrs.host,
    port,
    username: typeof attrs.username === 'string' && attrs.username ? attrs.username : 'root',
    private_key: attrs.private_key,
    remote_host_key: attrs.remote_host_key,
    connect_timeout: typeof attrs.connect_timeout === 'number' ? attrs.connect_timeout : 10,
  };
}

function renderSsh(mock: Mock, c: SshConfigState): Obj {
  const host = mock.state.network.hostname;
  const pubFile = (line: string) => Buffer.from(`${line} root@${host}\n`).toString('base64');
  const privFile = (seed: string) => Buffer.from(pem(Buffer.concat([MAGIC, Buffer.from(seed)]))).toString('base64');
  return {
    id: 1,
    bindiface: [...c.bindiface],
    tcpport: c.tcpport,
    password_login_groups: [...c.password_login_groups],
    passwordauth: c.passwordauth,
    kerberosauth: c.kerberosauth,
    tcpfwd: c.tcpfwd,
    compression: c.compression,
    sftp_log_level: c.sftp_log_level,
    sftp_log_facility: c.sftp_log_facility,
    weak_ciphers: [...c.weak_ciphers],
    options: c.options,
    privatekey: '',
    host_dsa_key: null,
    host_dsa_key_pub: null,
    host_dsa_key_cert_pub: null,
    host_ecdsa_key: privFile('ecdsa'),
    host_ecdsa_key_pub: pubFile(c.hostKeys.ecdsa),
    host_ecdsa_key_cert_pub: null,
    host_ed25519_key: privFile('ed25519'),
    host_ed25519_key_pub: pubFile(c.hostKeys.ed25519),
    host_ed25519_key_cert_pub: null,
    host_key: null,
    host_key_pub: null,
    host_rsa_key: privFile('rsa'),
    host_rsa_key_pub: pubFile(c.hostKeys.rsa),
    host_rsa_key_cert_pub: null,
  };
}

export function registerKeychain(mock: Mock): void {
  const { server } = mock;
  const list = () => mock.state.keychain.map(renderCredential);
  const emit = (c: KeychainCredentialState, msg: 'added' | 'changed') => mock.emit('keychaincredential.query', msg, c.id, renderCredential(c));
  const get = (id: unknown) => {
    const c = mock.state.keychain.find((k) => k.id === id);
    if (!c) throw callError('ENOENT', `Keychain credential ${String(id)} does not exist`);
    return c;
  };
  const uniqueName = (name: unknown, attr: string, exceptId?: number) => {
    if (typeof name !== 'string' || !name.trim()) throw validationError(`${attr}.name`, 'Field required');
    if (mock.state.keychain.some((k) => k.name === name && k.id !== exceptId)) throw validationError(`${attr}.name`, 'Object with this name already exists');
    return name;
  };

  server.method('keychaincredential.query', (p) => queryFilter(list(), p[0], p[1]));
  server.method('keychaincredential.get_instance', (p) => queryFilter(list(), [['id', '=', p[0]]], { get: true }));

  server.method('keychaincredential.create', (p) => {
    const attr = 'keychain_credential_create';
    const data = argObj(p[0], attr);
    const name = uniqueName(data.name, attr);
    if (data.type !== 'SSH_KEY_PAIR' && data.type !== 'SSH_CREDENTIALS') throw validationError(`${attr}.type`, "Input should be 'SSH_KEY_PAIR' or 'SSH_CREDENTIALS'");
    const attrs = argObj(data.attributes, `${attr}.attributes`);
    const attributes = data.type === 'SSH_KEY_PAIR' ? validateKeyPair(attrs, `${attr}.attributes`) : validateCredentials(mock, attrs, `${attr}.attributes`);
    const c: KeychainCredentialState = { id: mock.state.nextIds.keychain++, name, type: data.type, attributes };
    mock.state.keychain.push(c);
    emit(c, 'added');
    return renderCredential(c);
  });

  server.method('keychaincredential.update', (p) => {
    const attr = 'keychain_credential_update';
    const c = get(p[0]);
    const data = argObj(p[1], attr);
    if ('type' in data) throw validationError(`${attr}.type`, 'Extra inputs are not permitted');
    const name = 'name' in data ? uniqueName(data.name, attr, c.id) : c.name;
    const attrs = isObj(data.attributes) ? { ...c.attributes, ...data.attributes } : c.attributes;
    c.attributes = c.type === 'SSH_KEY_PAIR' ? validateKeyPair(attrs, `${attr}.attributes`) : validateCredentials(mock, attrs, `${attr}.attributes`);
    c.name = name;
    emit(c, 'changed');
    return renderCredential(c);
  });

  /** Things that depend on a credential: SSH connections use key pairs; replication tasks use connections. */
  const usedBy = (c: KeychainCredentialState) => {
    if (c.type === 'SSH_KEY_PAIR') {
      return mock.state.keychain
        .filter((k) => k.type === 'SSH_CREDENTIALS' && k.attributes.private_key === c.id)
        .map((k) => ({ title: `SSH credentials ${k.name}`, unbind_method: 'delete' as const, credential: k }));
    }
    return mock.state.replications
      .filter((r) => r.fields.ssh_credentials === c.id)
      .map((r) => ({ title: `Replication task ${String(r.fields.name)}`, unbind_method: 'disable' as const, replication: r }));
  };

  server.method('keychaincredential.used_by', (p) => usedBy(get(p[0])).map(({ title, unbind_method }) => ({ title, unbind_method })));

  const remove = (c: KeychainCredentialState, cascade: boolean): void => {
    for (const dep of usedBy(c)) {
      if (!cascade) throw validationError('options.cascade', 'This credential is used and no cascade option is specified');
      if ('credential' in dep) remove(dep.credential, cascade);
      else {
        // Replication tasks are disabled and unlinked, never deleted.
        dep.replication.fields.enabled = false;
        dep.replication.fields.ssh_credentials = null;
        mock.emit('replication.query', 'changed', dep.replication.id, { id: dep.replication.id });
      }
    }
    mock.state.keychain = mock.state.keychain.filter((k) => k.id !== c.id);
    mock.emit('keychaincredential.query', 'removed', c.id);
  };

  server.method('keychaincredential.delete', (p) => {
    remove(get(p[0]), isObj(p[1]) && p[1].cascade === true);
    return null;
  });

  server.method('keychaincredential.generate_ssh_key_pair', () => generateKeyPair(`root@${mock.state.network.hostname}`));

  server.method('keychaincredential.remote_ssh_host_key_scan', (p) => {
    const data = argObj(p[0], 'keychain_remote_ssh_host_key_scan');
    if (typeof data.host !== 'string' || !data.host) throw validationError('keychain_remote_ssh_host_key_scan.host', 'Field required');
    const port = typeof data.port === 'number' ? data.port : 22;
    const peer = findPeer(data.host, port);
    if (!peer || peer.state.services.find((s) => s.service === 'ssh')?.state !== 'RUNNING') {
      throw callError('EFAULT', `ssh-keyscan failed: connect to host ${data.host} port ${port}: Connection refused\n`);
    }
    return hostKeyLines(peer).join('\n');
  });

  // SSH service settings
  server.method('ssh.config', () => renderSsh(mock, mock.state.ssh));
  server.method('ssh.bindiface_choices', () => Object.fromEntries(mock.state.network.interfaces.map((i) => [i.name, i.name])));
  server.method('ssh.update', (p) => {
    const attr = 'ssh_update';
    const data = argObj(p[0], attr);
    const c = mock.state.ssh;
    const errors: Array<[string, string]> = [];
    for (const key of ['id', 'privatekey', 'host_ed25519_key', 'host_rsa_key', 'host_ecdsa_key']) {
      if (key in data) errors.push([`${attr}.${key}`, 'Extra inputs are not permitted']);
    }
    if ('tcpport' in data && (typeof data.tcpport !== 'number' || !Number.isInteger(data.tcpport) || data.tcpport < 1 || data.tcpport > 65535)) {
      errors.push([`${attr}.tcpport`, 'Input should be a valid port']);
    }
    if (errors.length) throw validationErrors(errors);
    for (const key of ['passwordauth', 'kerberosauth', 'tcpfwd', 'compression'] as const) if (typeof data[key] === 'boolean') c[key] = data[key];
    for (const key of ['bindiface', 'password_login_groups', 'weak_ciphers'] as const) if (Array.isArray(data[key])) c[key] = (data[key] as unknown[]).map(String);
    for (const key of ['sftp_log_level', 'sftp_log_facility', 'options'] as const) if (typeof data[key] === 'string') c[key] = data[key];
    if (typeof data.tcpport === 'number') c.tcpport = data.tcpport;
    return renderSsh(mock, c);
  });
}
