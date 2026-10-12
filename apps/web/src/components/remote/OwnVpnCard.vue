<script setup lang="ts">
/** Guidance for doing remote access without ApexOs setting anything up: a VPN on the router, or an HTTPS reverse proxy. */
import { Router } from 'lucide-vue-next';
import type { RemoteAccessStatus } from '@apexos/api-types';

defineProps<{ status: RemoteAccessStatus }>();
</script>

<template>
  <section class="card stack method" aria-labelledby="own-h">
    <div class="row wrap" style="--gap: 10px">
      <Router :size="22" class="method-icon" aria-hidden="true" />
      <h2 id="own-h">Your own VPN or reverse proxy</h2>
    </div>
    <p class="small">Already run your own network gear? ApexOs works behind it without any setup here.</p>

    <details class="guide">
      <summary>A VPN on your router (WireGuard or OpenVPN)</summary>
      <div class="small stack" style="--gap: 8px">
        <p>
          Many routers and firewalls can run a VPN server (look for WireGuard or VPN server in their settings). Your phone or laptop connects to it and is
          then on your home network, so everything works as at home:
        </p>
        <ul>
          <li v-if="status.localUrl">ApexOs: <code>{{ status.localUrl }}</code></li>
          <li v-if="status.lanIp">Shared folders: <code>\\{{ status.lanIp }}\Media</code> (Windows) or <code>smb://{{ status.lanIp }}/Media</code> (Mac)</li>
        </ul>
        <p>This usually needs one port forwarded on the router, and a dynamic DNS name if your internet address changes.</p>
      </div>
    </details>

    <details class="guide">
      <summary>A reverse proxy with HTTPS</summary>
      <div class="small stack" style="--gap: 8px">
        <p>
          If you already run Caddy, nginx, Traefik or similar with your own domain and certificate, point a hostname at
          <code>{{ status.localUrl ?? `http://<server address>:${status.port}` }}</code>. Only the web page is published; file sharing needs a VPN.
        </p>
        <ul>
          <li>Turn on two-factor sign-in first: your sign-in page will be on the internet.</li>
          <li>Start ApexOs with <code>APEXOS_SECURE_COOKIES=1</code> and pass <code>X-Forwarded-Proto</code> from the proxy.</li>
          <li>Don’t buffer <code>/api/events</code>: live updates use a long-running stream (Server-Sent Events).</li>
        </ul>
      </div>
    </details>

    <details class="guide">
      <summary>Other self-hosted options</summary>
      <div class="small stack" style="--gap: 8px">
        <p>
          <strong>Headscale</strong> replaces Tailscale’s coordination service with your own; choose “Use my own Headscale server” when setting up
          Tailscale. NetBird, ZeroTier and WireGuard (wg-easy) are in the TrueNAS app catalog too.
        </p>
        <p>
          <strong>TrueNAS Connect</strong> gives TrueNAS a web address and certificate that point at your home network. It doesn’t make anything reachable
          from outside, so it isn’t a remote access method on its own.
        </p>
      </div>
    </details>
  </section>
</template>

<style scoped>
.guide {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.guide summary {
  cursor: pointer;
  font-weight: 550;
}
.guide > div {
  margin-top: 10px;
}
.guide ul {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
code {
  overflow-wrap: anywhere;
}
</style>
