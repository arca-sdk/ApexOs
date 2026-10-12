import { describe, expect, it } from 'vitest';
import { createPool, failure, setup, type Any } from './helpers.ts';

const GiB = 1024 ** 3;

describe('datasets, SMB shares and ACLs', () => {
  it('creates a dataset with presets, quota and user properties', async () => {
    const { client } = await setup();
    await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    const ds = await client.call<Any>('pool.dataset.create', [
      { name: 'tank/Family', share_type: 'SMB', quota: 100 * GiB, comments: 'Family files', user_properties: [{ key: 'apexos:folder', value: 'family' }] },
    ]);
    expect(ds).toMatchObject({ id: 'tank/Family', name: 'tank/Family', pool: 'tank', type: 'FILESYSTEM', mountpoint: '/mnt/tank/Family', encrypted: false, locked: false });
    expect(ds.casesensitivity).toMatchObject({ value: 'INSENSITIVE', source: 'LOCAL' });
    expect(ds.acltype).toMatchObject({ value: 'NFSV4', rawvalue: 'nfsv4' });
    expect(ds.aclmode.value).toBe('RESTRICTED');
    expect(ds.compression).toMatchObject({ value: 'LZ4', source: 'INHERITED', source_info: 'tank' });
    expect(ds.quota).toMatchObject({ parsed: 100 * GiB, rawvalue: String(100 * GiB), value: '100G', source: 'LOCAL', source_info: null });
    expect(ds.refquota).toMatchObject({ parsed: null, rawvalue: '0', value: null, source: 'DEFAULT' });
    expect(ds.used.parsed).toBeGreaterThan(0);
    expect(ds.available.parsed).toBeLessThanOrEqual(100 * GiB);
    expect(ds.user_properties['apexos:folder']).toMatchObject({ value: 'family', rawvalue: 'family', source: 'LOCAL' });
    expect(ds.comments.value).toBe('Family files');

    const dup = await failure(client.call('pool.dataset.create', [{ name: 'tank/Family' }]));
    expect(dup.validationErrors['pool_dataset_create.name']).toMatch(/already exists/);
    const small = await failure(client.call('pool.dataset.create', [{ name: 'tank/Tiny', quota: 1024 }]));
    expect(small.validationErrors['pool_dataset_create.quota']).toMatch(/1 GiB/);
    const orphan = await failure(client.call('pool.dataset.create', [{ name: 'tank/a/b' }]));
    expect(orphan.validationErrors['pool_dataset_create.name']).toMatch(/create_ancestors/);
    const nested = await client.call<Any>('pool.dataset.create', [{ name: 'tank/a/b', create_ancestors: true, share_type: 'APPS' }]);
    expect(nested.atime.value).toBe('OFF');
    const badProp = await failure(client.call('pool.dataset.create', [{ name: 'tank/x', user_properties: [{ key: 'nocolon', value: '1' }] }]));
    expect(badProp.validationErrors['pool_dataset_create.user_properties.0.key']).toBeDefined();

    const updated = await client.call<Any>('pool.dataset.update', [
      'tank/Family',
      { quota: 0, user_properties_update: [{ key: 'apexos:folder', remove: true }, { key: 'apexos:owner', value: 'alice' }] },
    ]);
    expect(updated.quota.parsed).toBeNull();
    expect(updated.user_properties).toEqual({ 'apexos:owner': expect.objectContaining({ value: 'alice' }) });
    const filtered = await client.call<Any[]>('pool.dataset.query', [[['user_properties.apexos:owner.value', '=', 'alice']]]);
    expect(filtered.map((d) => d.id)).toEqual(['tank/Family']);
    const byPool = await client.call<Any[]>('pool.dataset.query', [[['pool', '=', 'tank']], { select: ['id', 'used.parsed'], order_by: ['id'] }]);
    expect(byPool[0]).toEqual({ id: 'tank', used: { parsed: expect.any(Number) } });
  });

  it('shares a dataset over SMB and manages share and filesystem ACLs', async () => {
    const { client } = await setup();
    await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    await client.call('pool.dataset.create', [{ name: 'tank/Family', share_type: 'SMB' }]);
    const bob = await client.call<Any>('user.create', [{ username: 'bob', full_name: 'Bob', password: 'hunter22', group_create: true, smb: true }]);
    expect(bob.uid).toBe(3000);

    const precheck = await client.call('sharing.smb.share_precheck', [{ name: 'Family' }]);
    expect(precheck).toBeNull();
    const share = await client.call<Any>('sharing.smb.create', [{ name: 'Family', path: '/mnt/tank/Family', purpose: 'DEFAULT_SHARE', comment: 'Shared' }]);
    expect(share).toMatchObject({
      id: 1,
      name: 'Family',
      path: '/mnt/tank/Family',
      purpose: 'DEFAULT_SHARE',
      enabled: true,
      browsable: true,
      readonly: false,
      locked: false,
      options: { aapl_name_mangling: false, hostsallow: [], hostsdeny: [] },
      audit: { enable: false, watch_list: [], ignore_list: [] },
    });
    expect((await client.call<Any>('sharing.smb.getacl', [{ share_name: 'Family' }])).share_acl).toEqual([
      { ae_perm: 'FULL', ae_type: 'ALLOWED', ae_who_sid: 'S-1-1-0', ae_who_id: null, ae_who_str: 'everyone@' },
    ]);
    const serverSid = (await client.call<Any>('smb.config')).server_sid;
    const acl = await client.call<Any>('sharing.smb.setacl', [
      {
        share_name: 'Family',
        share_acl: [
          { ae_who_id: { id_type: 'USER', id: 3000 }, ae_perm: 'CHANGE', ae_type: 'ALLOWED' },
          { ae_who_id: { id_type: 'GROUP', id: 544 }, ae_perm: 'FULL', ae_type: 'ALLOWED' },
          { ae_who_sid: 'S-1-5-32-545', ae_perm: 'READ', ae_type: 'ALLOWED' },
        ],
      },
    ]);
    expect(acl.share_acl[2]).toMatchObject({ ae_who_sid: 'S-1-5-32-545', ae_who_id: { id_type: 'GROUP', id: 545 }, ae_who_str: 'builtin_users' });
    expect(acl.share_acl[0]).toEqual({ ae_perm: 'CHANGE', ae_type: 'ALLOWED', ae_who_sid: `${serverSid}-${20000 + bob.id}`, ae_who_id: { id_type: 'USER', id: 3000 }, ae_who_str: 'bob' });
    expect(acl.share_acl[1]).toMatchObject({ ae_who_sid: `${serverSid}-512`, ae_who_id: { id_type: 'GROUP', id: 544 }, ae_who_str: 'builtin_administrators' });
    expect(bob.sid).toBe(`${serverSid}-${20000 + bob.id}`);
    const unknown = await failure(client.call('sharing.smb.setacl', [{ share_name: 'Family', share_acl: [{ ae_who_id: { id_type: 'USER', id: 4242 }, ae_perm: 'READ', ae_type: 'ALLOWED' }] }]));
    expect(unknown.validationErrors['sharing_smb_setacl.share_acl.0.ae_who_id']).toMatch(/SMB account/);
    // truenas_admin (uid 950) is not an SMB account, so like the real middleware it cannot appear in share ACLs.
    const admin = await failure(client.call('sharing.smb.setacl', [{ share_name: 'Family', share_acl: [{ ae_who_id: { id_type: 'USER', id: 950 }, ae_perm: 'FULL', ae_type: 'ALLOWED' }] }]));
    expect(admin.validationErrors['sharing_smb_setacl.share_acl.0.ae_who_id']).toMatch(/SMB account/);
    const unixSid = await failure(client.call('sharing.smb.setacl', [{ share_name: 'Family', share_acl: [{ ae_who_sid: 'S-1-22-1-950', ae_perm: 'FULL', ae_type: 'ALLOWED' }] }]));
    expect(unixSid.validationErrors['sharing_smb_setacl.share_acl.0.sid']).toMatch(/specially-encoded/);

    // Validation
    const badName = await failure(client.call('sharing.smb.create', [{ name: 'bad:name', path: '/mnt/tank/Family' }]));
    expect(badName.validationErrors['sharingsmb_create.name']).toMatch(/invalid characters/);
    const dupName = await failure(client.call('sharing.smb.create', [{ name: 'FAMILY', path: '/mnt/tank/Family' }]));
    expect(dupName.validationErrors['sharingsmb_create.name']).toMatch(/already exists/);
    const noPath = await failure(client.call('sharing.smb.create', [{ name: 'Ghost', path: '/mnt/tank/Ghost' }]));
    expect(noPath.validationErrors['sharingsmb_create.path']).toMatch(/does not exist/);
    const outside = await failure(client.call('sharing.smb.create', [{ name: 'Etc', path: '/etc' }]));
    expect(outside.validationErrors['sharingsmb_create.path']).toMatch(/pool/);
    const guestDefault = await failure(client.call('sharing.smb.create', [{ name: 'Guest', path: '/mnt/tank/Family', purpose: 'DEFAULT_SHARE', options: { guestok: true } }]));
    expect(guestDefault.validationErrors['sharingsmb_create.options.guestok']).toBeDefined();
    const guest = await client.call<Any>('sharing.smb.create', [{ name: 'Guest', path: '/mnt/tank/Family', purpose: 'LEGACY_SHARE', options: { guestok: true } }]);
    expect(guest.options).toMatchObject({ guestok: true, recyclebin: false, timemachine: false });

    await client.call('pool.dataset.create', [{ name: 'tank/TimeMachine', share_type: 'SMB' }]);
    const tm = await failure(client.call('sharing.smb.create', [{ name: 'TimeMachine', path: '/mnt/tank/TimeMachine', purpose: 'TIMEMACHINE_SHARE' }]));
    expect(tm.validationErrors['sharingsmb_create.purpose']).toMatch(/Apple SMB2\/3/);
    await client.call('smb.update', [{ aapl_extensions: true }]);
    const tmShare = await client.call<Any>('sharing.smb.create', [{ name: 'TimeMachine', path: '/mnt/tank/TimeMachine', purpose: 'TIMEMACHINE_SHARE', options: { timemachine_quota: 500 * GiB } }]);
    expect(tmShare.options.vuid).toMatch(/^[0-9a-f-]{36}$/);
    await expect(client.call('smb.update', [{ aapl_extensions: false }])).rejects.toThrow(/Time Machine/);
    await expect(client.call('smb.update', [{ netbiosname: 'this-name-is-way-too-long' }])).rejects.toThrow(/NetBIOS/);

    const renamed = await client.call<Any>('sharing.smb.update', [share.id, { name: 'Household', comment: 'Renamed' }]);
    expect(renamed).toMatchObject({ name: 'Household', comment: 'Renamed' });
    expect((await client.call<Any>('sharing.smb.getacl', [{ share_name: 'Household' }])).share_acl).toHaveLength(3);

    // Filesystem ACLs
    const before = await client.call<Any>('filesystem.getacl', ['/mnt/tank/Family']);
    expect(before).toMatchObject({ path: '/mnt/tank/Family', acltype: 'NFS4', trivial: false, uid: 0, gid: 0 });
    const setResult = await client.job<Any>('filesystem.setacl', [
      {
        path: '/mnt/tank/Family',
        dacl: [
          { tag: 'owner@', id: null, type: 'ALLOW', perms: { BASIC: 'FULL_CONTROL' }, flags: { BASIC: 'INHERIT' } },
          { tag: 'group@', id: null, type: 'ALLOW', perms: { BASIC: 'MODIFY' }, flags: { BASIC: 'INHERIT' } },
          { tag: 'USER', who: 'bob', type: 'ALLOW', perms: { BASIC: 'MODIFY' }, flags: { BASIC: 'INHERIT' } },
        ],
        user: 'bob',
        options: { recursive: true },
      },
    ]);
    expect(setResult.uid).toBe(3000);
    const after = await client.call<Any>('filesystem.getacl', ['/mnt/tank/Family', true, true]);
    expect(after.acl).toContainEqual(expect.objectContaining({ tag: 'USER', id: 3000, who: 'bob', perms: { BASIC: 'MODIFY' } }));
    expect(after.user).toBe('bob');
    const posixOnNfs = await failure(client.job('filesystem.setacl', [{ path: '/mnt/tank/Family', acltype: 'POSIX1E', dacl: [] }]));
    expect(posixOnNfs.validationErrors['filesystem_acl.acltype']).toMatch(/mismatch/);
    const noUser = await failure(client.job('filesystem.setacl', [{ path: '/mnt/tank/Family', dacl: [{ tag: 'USER', who: 'mallory', type: 'ALLOW', perms: { BASIC: 'READ' }, flags: { BASIC: 'INHERIT' } }] }]));
    expect(noUser.validationErrors['filesystem_acl.dacl.0.who']).toMatch(/does not exist/);

    // A new folder inherits the ACL; setperm needs stripacl on ACL'd paths.
    const dir = await client.call<Any>('filesystem.mkdir', [{ path: '/mnt/tank/Family/Recipes', options: { mode: '775' } }]);
    expect(dir).toMatchObject({ name: 'Recipes', type: 'DIRECTORY', acl: true });
    await expect(client.call('filesystem.mkdir', [{ path: '/mnt/tank/Family/Recipes' }])).rejects.toThrow(/already exists/);
    const listing = await client.call<Any[]>('filesystem.listdir', ['/mnt/tank', [['type', '=', 'DIRECTORY']], { order_by: ['name'] }]);
    expect(listing.map((e) => e.name)).toEqual(['Family', 'TimeMachine']);
    expect(listing[0]).toMatchObject({ path: '/mnt/tank/Family', is_mountpoint: true, acl: true });
    const stat = await client.call<Any>('filesystem.stat', ['/mnt/tank/Family/Recipes']);
    expect(stat).toMatchObject({ type: 'DIRECTORY', uid: 3000, user: 'bob', acl: true });
    await expect(client.call('filesystem.stat', ['/mnt/tank/Nope'])).rejects.toThrow(/not found/);
    const strip = await failure(client.job('filesystem.setperm', [{ path: '/mnt/tank/Family', mode: '770', options: {} }]));
    expect(strip.validationErrors['filesystem.setperm.mode']).toMatch(/Non-trivial ACL/);
    await client.job('filesystem.setperm', [{ path: '/mnt/tank/Family', mode: '770', options: { stripacl: true } }]);
    expect((await client.call<Any>('filesystem.getacl', ['/mnt/tank/Family'])).trivial).toBe(true);

    // Attachments, then deleting the dataset removes its shares.
    expect(await client.call('pool.dataset.attachments', ['tank/Family'])).toEqual([{ type: 'SMB Share', service: 'cifs', attachments: ['Household', 'Guest'] }]);
    await client.call('pool.dataset.create', [{ name: 'tank/Family/Kids' }]);
    await client.call('pool.snapshot.create', [{ dataset: 'tank/Family', name: 'before-cleanup' }]);
    const busy = await failure(client.call('pool.dataset.delete', ['tank/Family']));
    expect(busy.reason).toMatch(/has children/);
    const smbEvents: Any[] = [];
    await client.subscribe('sharing.smb.query', (u) => smbEvents.push(u));
    expect(await client.call('pool.dataset.delete', ['tank/Family', { recursive: true }])).toBe(true);
    expect((await client.call<Any[]>('sharing.smb.query')).map((s) => s.name)).toEqual(['TimeMachine']);
    expect(smbEvents.filter((e) => e.msg === 'removed')).toHaveLength(2);
    expect(await client.call('pool.snapshot.query', [[['dataset', '=', 'tank/Family']]])).toEqual([]);
  });

  it('enables the SMB service', async () => {
    const { client } = await setup();
    expect(await client.call('service.query', [[['service', '=', 'cifs']], { get: true }])).toMatchObject({ enable: false, state: 'STOPPED' });
    expect(await client.call('service.update', ['cifs', { enable: true }])).toBe(4);
    expect(await client.job('service.control', ['START', 'cifs', { silent: false }])).toBe(true);
    expect(await client.call('service.query', [[['service', '=', 'cifs']], { get: true }])).toMatchObject({ enable: true, state: 'RUNNING', pids: expect.any(Array) });
    expect(await client.job('service.control', ['START', 'docker', { silent: true }])).toBe(false);
    await expect(client.call('service.control', ['BOOT', 'cifs'])).rejects.toThrow();
  });

  it('takes and rolls back snapshots', async () => {
    const { client } = await setup();
    await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    await client.call('pool.dataset.create', [{ name: 'tank/Docs' }]);
    const snap = await client.call<Any>('pool.snapshot.create', [{ dataset: 'tank/Docs', naming_schema: 'auto-%Y-%m-%d_%H-%M' }]);
    expect(snap).toMatchObject({ dataset: 'tank/Docs', type: 'SNAPSHOT', pool: 'tank' });
    expect(snap.snapshot_name).toMatch(/^auto-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/);
    await client.call('pool.snapshot.create', [{ dataset: 'tank/Docs', name: 'later' }]);
    await expect(client.call('pool.snapshot.rollback', [snap.id])).rejects.toThrow(/more recent snapshots/);
    expect(await client.call('pool.snapshot.rollback', [snap.id, { recursive: true }])).toBeNull();
    expect((await client.call<Any[]>('pool.snapshot.query', [[], { select: ['id'] }])).map((s) => s.id)).toEqual([snap.id]);
    expect(await client.call('pool.snapshot.delete', [snap.id])).toBe(true);
  });
});

describe('users and groups', () => {
  it('creates, updates and deletes share users', async () => {
    const { client } = await setup();
    const alice = await client.call<Any>('user.create', [{ username: 'alice', full_name: 'Alice', password: 's3cret!', group_create: true, smb: true }]);
    expect(alice).toMatchObject({ uid: 3000, username: 'alice', smb: true, builtin: false, local: true, home: '/var/empty', password: null, roles: [] });
    expect(alice.group).toMatchObject({ bsdgrp_gid: 3000, bsdgrp_group: 'alice' });
    expect(alice.sid).toMatch(/^S-1-5-21-/);
    expect(alice.last_password_change).toHaveProperty('$date');

    const dup = await failure(client.call('user.create', [{ username: 'alice', full_name: 'Again', password: 'x', group_create: true }]));
    expect(dup.validationErrors['user_create.username']).toMatch(/already exists/);
    const noPw = await failure(client.call('user.create', [{ username: 'carol', full_name: 'Carol', group_create: true, smb: true }]));
    expect(noPw.validationErrors['user_create.password']).toBeDefined();
    const badName = await failure(client.call('user.create', [{ username: '-carol', full_name: 'Carol', password: 'x', group_create: true }]));
    expect(badName.validationErrors['user_create.username']).toBeDefined();
    const noGroup = await failure(client.call('user.create', [{ username: 'carol', full_name: 'Carol', password: 'x' }]));
    expect(noGroup.validationErrors['user_create.group']).toBeDefined();
    const random = await client.call<Any>('user.create', [{ username: 'svc', full_name: 'Service', random_password: true, group: 3, smb: false }]);
    expect(random.password).toHaveLength(20);
    expect(random.uid).toBe(3001);

    const updated = await client.call<Any>('user.update', [alice.id, { full_name: 'Alice Doe', password: 'n3w-pass' }]);
    expect(updated.full_name).toBe('Alice Doe');
    const enableSmb = await failure(client.call('user.update', [random.id, { smb: true }]));
    expect(enableSmb.validationErrors['user_update.smb']).toMatch(/password/);
    const rootRename = await failure(client.call('user.update', [1, { username: 'admin' }]));
    expect(rootRename.validationErrors['user_update.username']).toMatch(/cannot be changed/);

    const nonBuiltin = await client.call<Any[]>('user.query', [[['builtin', '=', false]], { order_by: ['uid'] }]);
    expect(nonBuiltin.map((u) => u.username)).toEqual(['truenas_admin', 'alice', 'svc']);
    expect(nonBuiltin[0]).toMatchObject({ uid: 950, smb: false, roles: ['FULL_ADMIN'] });
    expect(await client.call('user.get_user_obj', [{ username: 'alice' }])).toMatchObject({ pw_uid: 3000, pw_gid: 3000, pw_name: 'alice' });
    const groups = await client.call<Any[]>('group.query', [[['name', 'in', ['alice', 'apps', 'builtin_users', 'builtin_administrators', 'truenas_admin']]], { order_by: ['gid'] }]);
    expect(groups.map((g) => [g.name, g.gid])).toEqual([
      ['builtin_administrators', 544],
      ['builtin_users', 545],
      ['apps', 568],
      ['truenas_admin', 950],
      ['alice', 3000],
    ]);
    expect(groups.find((g) => g.name === 'alice').users).toEqual([alice.id]);

    expect(await client.call('user.delete', [alice.id])).toBe(alice.id);
    expect(await client.call('user.query', [[['username', '=', 'alice']]])).toEqual([]);
    expect(await client.call('group.query', [[['name', '=', 'alice']]])).toEqual([]);
    await expect(client.call('user.delete', [1])).rejects.toThrow(/built-in/);
    await expect(client.call('user.delete', [999])).rejects.toThrow(/does not exist/);
  });
});
