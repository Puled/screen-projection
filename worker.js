
import { DurableObject } from "cloudflare:workers";

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Screen Projector</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--text:#171717;--muted:#686868;--line:#dedee2;--accent:#2563eb;--soft:#edf3ff}
@media(prefers-color-scheme:dark){:root{--bg:#111214;--panel:#1b1d21;--text:#eceef2;--muted:#a5a8b0;--line:#383b42;--accent:#83aaff;--soft:#252e40}}
*{box-sizing:border-box}
body{font:15px/1.45 system-ui,-apple-system,sans-serif;max-width:1100px;margin:0 auto;padding:clamp(12px,3vw,28px);background:var(--bg);color:var(--text)}
header,.toolbar,.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
header{justify-content:space-between;margin-bottom:14px}h1{font-size:1.25rem;margin:0;font-weight:650}
#status{color:var(--muted);font-size:.9rem;min-height:1.4em}
button,select{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px 13px;min-height:42px}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:white}
button:disabled,select:disabled{opacity:.45;cursor:not-allowed}
#count,#quality{font-size:.82rem;color:var(--muted);margin:8px 0}
video{display:block;width:100%;max-height:72vh;aspect-ratio:16/9;object-fit:contain;background:#050505;border-radius:10px}
#files{margin-top:16px;padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
#drop{border:1.5px dashed var(--line);border-radius:9px;padding:18px 12px;text-align:center;color:var(--muted);cursor:pointer;outline:none}
#drop.drag{border-color:var(--accent);background:var(--soft)}
#fileStatus{display:block;color:var(--muted);font-size:.82rem;margin-top:8px;overflow-wrap:anywhere}
#downloads{display:flex;flex-direction:column;gap:6px;margin-top:8px}
#downloads a{color:var(--accent);overflow-wrap:anywhere}
#fileInput{display:none}
@media(max-width:600px){body{padding:12px}header{align-items:flex-start;flex-direction:column;gap:4px}.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:8px}.toolbar select{grid-column:1/-1;width:100%}.toolbar button{width:100%;padding:10px 7px}video{max-height:62vh;aspect-ratio:4/3}#files{padding:10px}#drop{padding:24px 10px}}
</style>
</head>
<body>
<header><h1>Screen Projector</h1><div id="status">Connecting…</div></header>
<div class="toolbar">
<select id="audioMode" aria-label="Audio source">
<option value="none">No audio</option>
<option value="device">Shared screen / tab audio</option>
<option value="microphone">Microphone</option>
</select>
<button id="share" class="primary" disabled>Share screen</button>
<button id="stop" disabled>Stop sharing</button>
<button id="enableAudio">Enable audio</button>
</div>
<div id="count">1 / 2 devices</div>
<video id="screen" autoplay playsinline controls></video>
<div id="quality"></div>
<section id="files">
  <div id="drop" tabindex="0" role="button" aria-label="Choose or drop files">
    Drop files here or <strong>choose files</strong>
    <input id="fileInput" type="file" multiple>
  </div>
  <small id="fileStatus">Peer-to-peer file sharing · up to 100 MB per file</small>
  <div id="downloads"></div>
</section>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status"), countEl = $("count"), shareBtn = $("share"), stopBtn = $("stop");
  const audioModeEl = $("audioMode"), enableAudioBtn = $("enableAudio"), video = $("screen");
  const qualityEl = $("quality"), dropEl = $("drop"), fileInput = $("fileInput");
  const fileStatus = $("fileStatus"), downloadsEl = $("downloads");
  const MAX_FILE = 100 * 1024 * 1024, CHUNK = 16 * 1024, HIGH_WATER = 1024 * 1024;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let ws = null, clientId, peerId = null, pc = null, dataChannel = null, localStream = null;
  let pendingCandidates = [], reconnectTimer = null, reconnectDelay = 1000, heartbeatTimer = null;
  let lastPong = Date.now(), busy = false, sharing = false, remoteSharing = false, makingOffer = false;
  let restartTimer = null, statsTimer = null, lastVideoStats = null, captureHasAudio = false;
  let incomingFiles = new Map(), objectUrls = [], sendingFiles = false;

  try {
    clientId = sessionStorage.getItem("screen-projector-client-id");
    if (!clientId) {
      clientId = crypto.randomUUID();
      sessionStorage.setItem("screen-projector-client-id", clientId);
    }
  } catch (_) { clientId = crypto.randomUUID(); }

  const setStatus = (value) => { statusEl.textContent = value; };
  const send = (message) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const update = () => {
    countEl.textContent = (peerId ? "2" : "1") + " / 2 devices";
    shareBtn.disabled = !peerId || !ws || ws.readyState !== WebSocket.OPEN || busy || sharing || remoteSharing;
    stopBtn.disabled = !sharing;
    audioModeEl.disabled = busy || sharing;
    const channelOpen = !!dataChannel && dataChannel.readyState === "open";
    fileInput.disabled = !channelOpen || sendingFiles;
    dropEl.setAttribute("aria-disabled", String(!channelOpen || sendingFiles));
    dropEl.style.opacity = channelOpen ? "1" : ".55";
  };

  function closePeer() {
    clearTimeout(restartTimer);
    if (dataChannel) {
      try { dataChannel.close(); } catch (_) {}
      dataChannel = null;
    }
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    pendingCandidates = [];
    video.srcObject = null;
    qualityEl.textContent = "";
    lastVideoStats = null;
    update();
  }

  function stopLocal(release) {
    if (release) send({ type: "release" });
    if (localStream) {
      localStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      localStream = null;
    }
    sharing = false;
    busy = false;
    captureHasAudio = false;
    closePeer();
    update();
  }

  function attachDataChannel(channel) {
    if (dataChannel && dataChannel !== channel) {
      try { dataChannel.close(); } catch (_) {}
    }
    dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.onopen = () => {
      fileStatus.textContent = "Peer-to-peer file sharing ready · up to 100 MB per file";
      update();
    };
    channel.onclose = () => {
      if (dataChannel === channel) dataChannel = null;
      fileStatus.textContent = "File channel disconnected";
      update();
    };
    channel.onerror = () => { fileStatus.textContent = "File transfer connection error"; };
    channel.onmessage = (event) => receiveFileMessage(event.data);
    update();
  }

  async function configureVideoSender(sender) {
    try {
      if (sender.track) sender.track.contentHint = "detail";
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = 10_000_000;
      params.encodings[0].maxFramerate = 30;
      params.degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    } catch (error) {
      console.debug("Using browser-default video adaptation", error);
    }
  }

  function makePeerConnection() {
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      bundlePolicy: "max-bundle"
    });
    connection.onicecandidate = (event) => {
      if (event.candidate && peerId) {
        send({ type: "candidate", to: peerId, payload: event.candidate.toJSON() });
      }
    };
    connection.ontrack = (event) => {
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.muted = false;
      video.play().catch(() => setStatus("Screen received · tap Enable audio"));
      setStatus("Receiving screen" + (event.track.kind === "audio" ? " and audio" : ""));
    };
    connection.ondatachannel = (event) => attachDataChannel(event.channel);
    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "connected") {
        clearTimeout(restartTimer);
        setStatus(sharing ? "Sharing" : "Connected");
      } else if (state === "disconnected") {
        scheduleIceRestart(6000);
        setStatus("Network interrupted · attempting recovery…");
      } else if (state === "failed") {
        scheduleIceRestart(500);
        setStatus("Connection lost · reconnecting…");
      }
    };
    connection.oniceconnectionstatechange = () => {
      if (connection.iceConnectionState === "failed") scheduleIceRestart(500);
    };
    return connection;
  }

  function scheduleIceRestart(delay) {
    clearTimeout(restartTimer);
    if (!sharing || !peerId) return;
    restartTimer = setTimeout(() => {
      if (!sharing || !peerId || !pc) return;
      if (["failed", "disconnected"].includes(pc.connectionState) ||
          ["failed", "disconnected"].includes(pc.iceConnectionState)) {
        const channelDead = dataChannel && dataChannel.readyState === "closed";
        startOffer(channelDead ? false : true);
      }
    }, delay);
  }

  async function startOffer(iceRestart) {
    if (!sharing || !peerId || !ws || ws.readyState !== WebSocket.OPEN || makingOffer) return;
    makingOffer = true;
    try {
      if (iceRestart && pc && pc.signalingState === "stable") {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
      } else {
        closePeer();
        pc = makePeerConnection();
        for (const track of localStream.getTracks()) {
          const sender = pc.addTrack(track, localStream);
          if (track.kind === "video") await configureVideoSender(sender);
        }
        attachDataChannel(pc.createDataChannel("files", { ordered: true }));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
      }
      send({ type: "offer", to: peerId, payload: pc.localDescription });
      setStatus("Sharing · connecting…");
    } catch (error) {
      console.error(error);
      setStatus("Connection setup failed · retrying…");
      if (iceRestart) setTimeout(() => startOffer(false), 1200);
    } finally {
      makingOffer = false;
    }
  }

  async function flushCandidates() {
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingCandidates.splice(0);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch (error) { console.debug("ICE candidate", error); }
    }
  }

  async function handleSignal(message) {
    if (message.type === "offer") {
      if (!pc || pc.connectionState === "closed") pc = makePeerConnection();
      await pc.setRemoteDescription(message.payload);
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", to: message.from, payload: pc.localDescription });
      setStatus("Connecting…");
    } else if (message.type === "answer") {
      if (!pc) return;
      await pc.setRemoteDescription(message.payload);
      await flushCandidates();
    } else if (message.type === "candidate") {
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(message.payload); } catch (error) { console.debug("ICE candidate", error); }
      } else {
        pendingCandidates.push(message.payload);
      }
    }
  }

  async function handleMessage(message) {
    if (message.type === "welcome") {
      myId = message.id;
      peerId = (message.peers || [])[0] || null;
      remoteSharing = message.peerRole === "presenter";
      reconnectDelay = 1000;
      if (message.role === "presenter") {
        if (localStream && localStream.active) {
          sharing = true;
          remoteSharing = false;
          await startOffer(false);
        } else {
          send({ type: "release" });
          sharing = false;
          setStatus("Session restored · select Share screen to resume");
        }
      } else {
        setStatus(!peerId ? "Waiting for second device…" : remoteSharing ? "Other device is sharing" : "Connected");
      }
      update();
      return;
    }
    if (message.type === "peer-joined" || message.type === "peer-reconnected") {
      const changed = peerId !== message.id || message.type === "peer-reconnected";
      peerId = message.id;
      remoteSharing = message.role === "presenter";
      if (changed) closePeer();
      if (sharing && localStream) await startOffer(false);
      else setStatus(remoteSharing ? "Other device is sharing" : "Connected");
      update();
      return;
    }
    if (message.type === "peer-left") {
      if (message.id === peerId) {
        peerId = null;
        remoteSharing = false;
        closePeer();
        setStatus(sharing ? "Peer disconnected · waiting to reconnect…" : "Peer disconnected · waiting for second device…");
      }
      update();
      return;
    }
    if (message.type === "claim-ok") {
      remoteSharing = false;
      busy = false;
      sharing = true;
      update();
      await startOffer(false);
      return;
    }
    if (message.type === "claim-denied") {
      stopLocal(false);
      remoteSharing = true;
      setStatus(message.reason || "Other device is already sharing");
      return;
    }
    if (message.type === "presenter-started") {
      remoteSharing = true;
      update();
      setStatus("Other device is starting to share…");
      return;
    }
    if (message.type === "presenter-stopped") {
      remoteSharing = false;
      closePeer();
      setStatus("Sharing stopped");
      return;
    }
    if (message.type === "peer-missing") setStatus("Peer not connected");
    if (["offer", "answer", "candidate"].includes(message.type) && message.from === peerId) {
      try { await handleSignal(message); }
      catch (error) { console.error(error); setStatus("Connection negotiation failed"); }
    }
  }

  function connect() {
    if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) return;
    clearTimeout(reconnectTimer);
    const role = localStream && localStream.active && sharing ? "presenter" : "viewer";
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    const socket = new WebSocket(scheme + location.host + "/ws?id=" + encodeURIComponent(clientId) + "&role=" + role);
    ws = socket;
    socket.onopen = () => { lastPong = Date.now(); setStatus("Connected · waiting for peer…"); };
    socket.onmessage = async (event) => {
      if (event.data === "pong") { lastPong = Date.now(); return; }
      try { await handleMessage(JSON.parse(event.data)); }
      catch (error) { console.error(error); setStatus("Signaling error"); }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      setStatus("Signaling disconnected · reconnecting…");
      scheduleReconnect();
    };
    socket.onerror = () => setStatus("Signaling connection error");
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (Date.now() - lastPong > 65000) { ws.close(); return; }
        try { ws.send("ping"); } catch (_) { ws.close(); }
      } else if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    }, 25000);
  }

  function formatBytes(value) {
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }

  function waitForBuffer(channel) {
    if (channel.readyState !== "open") return Promise.reject(new Error("File channel closed"));
    if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error("File transfer stalled")); }, 60000);
      const cleanup = () => {
        clearTimeout(timeout);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("File channel closed")); };
      channel.addEventListener("bufferedamountlow", onLow, { once: true });
      channel.addEventListener("close", onClose, { once: true });
    });
  }

  async function sendFiles(files) {
    const channel = dataChannel;
    if (!channel || channel.readyState !== "open" || sendingFiles) return;
    sendingFiles = true;
    update();
    try {
      for (const file of files) {
        if (file.size > MAX_FILE) {
          fileStatus.textContent = file.name + " exceeds the 100 MB limit";
          continue;
        }
        const id = crypto.randomUUID().replace(/-/g, "");
        channel.send(JSON.stringify({ type: "file-start", id, name: file.name, size: file.size, mime: file.type || "application/octet-stream" }));
        let offset = 0, sequence = 0;
        while (offset < file.size) {
          await waitForBuffer(channel);
          const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
          const packet = new Uint8Array(36 + chunk.byteLength);
          packet.set(encoder.encode(id), 0);
          new DataView(packet.buffer).setUint32(32, sequence++, false);
          packet.set(chunk, 36);
          channel.send(packet.buffer);
          offset += chunk.byteLength;
          fileStatus.textContent = "Sending " + file.name + " · " + Math.round(offset / Math.max(file.size, 1) * 100) + "%";
        }
        channel.send(JSON.stringify({ type: "file-end", id }));
        fileStatus.textContent = "Sent " + file.name;
      }
    } catch (error) {
      fileStatus.textContent = "Transfer interrupted: " + error.message;
    } finally {
      sendingFiles = false;
      fileInput.value = "";
      update();
    }
  }

  function receiveFileMessage(data) {
    if (typeof data === "string") {
      let message;
      try { message = JSON.parse(data); } catch (_) { return; }
      if (message.type === "file-start") {
        if (!Number.isSafeInteger(message.size) || message.size < 0 || message.size > MAX_FILE) {
          fileStatus.textContent = "Rejected oversized file";
          dataChannel?.send(JSON.stringify({ type: "file-reject", id: message.id }));
          return;
        }
        incomingFiles.set(message.id, { name: message.name, size: message.size, mime: message.mime, parts: [], received: 0, sequence: 0 });
        fileStatus.textContent = "Receiving " + message.name + " · 0%";
      } else if (message.type === "file-end") {
        const file = incomingFiles.get(message.id);
        if (!file) return;
        incomingFiles.delete(message.id);
        if (file.received !== file.size) {
          fileStatus.textContent = "Incomplete file: " + file.name;
          return;
        }
        const blob = new Blob(file.parts, { type: file.mime });
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.textContent = "Download " + file.name + " (" + formatBytes(file.size) + ")";
        downloadsEl.prepend(link);
        fileStatus.textContent = "Received " + file.name;
      } else if (message.type === "file-reject") {
        fileStatus.textContent = "Receiver rejected a file";
      }
      return;
    }
    const packet = new Uint8Array(data);
    if (packet.byteLength < 36) return;
    const id = decoder.decode(packet.subarray(0, 32));
    const file = incomingFiles.get(id);
    if (!file) return;
    const sequence = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(32, false);
    if (sequence !== file.sequence++) {
      incomingFiles.delete(id);
      fileStatus.textContent = "File transfer sequence error: " + file.name;
      return;
    }
    const chunk = packet.slice(36);
    file.parts.push(chunk);
    file.received += chunk.byteLength;
    fileStatus.textContent = "Receiving " + file.name + " · " + Math.round(file.received / Math.max(file.size, 1) * 100) + "%";
  }

  async function refreshQuality() {
    if (!pc || pc.connectionState === "closed") return;
    try {
      const stats = await pc.getStats();
      let report = null;
      for (const item of stats.values()) {
        if ((item.type === "outbound-rtp" || item.type === "inbound-rtp") &&
            (item.kind === "video" || item.mediaType === "video") && !item.isRemote) {
          report = item;
          if (sharing && item.type === "outbound-rtp") break;
          if (!sharing && item.type === "inbound-rtp") break;
        }
      }
      if (!report) return;
      const now = report.timestamp || Date.now();
      let rate = 0;
      if (lastVideoStats && lastVideoStats.id === report.id && report.bytesSent !== undefined && lastVideoStats.bytes !== undefined) {
        rate = Math.max(0, (report.bytesSent - lastVideoStats.bytes) * 8 / Math.max((now - lastVideoStats.time) / 1000, .001));
      } else if (lastVideoStats && lastVideoStats.id === report.id && report.bytesReceived !== undefined && lastVideoStats.bytes !== undefined) {
        rate = Math.max(0, (report.bytesReceived - lastVideoStats.bytes) * 8 / Math.max((now - lastVideoStats.time) / 1000, .001));
      }
      const bytes = report.bytesSent ?? report.bytesReceived;
      lastVideoStats = { id: report.id, bytes, time: now };
      const size = report.frameWidth && report.frameHeight ? report.frameWidth + "×" + report.frameHeight : "resolution pending";
      const fps = report.framesPerSecond ? " · " + Math.round(report.framesPerSecond) + " fps" : "";
      const kbps = rate > 0 ? " · " + Math.round(rate / 1000) + " kbps" : "";
      const limit = report.qualityLimitationReason && report.qualityLimitationReason !== "none" ? " · " + report.qualityLimitationReason : "";
      qualityEl.textContent = size + fps + kbps + limit;
    } catch (_) {}
  }

  shareBtn.addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("Screen sharing unsupported in this browser");
      return;
    }
    busy = true;
    update();
    try {
      const mode = audioModeEl.value;
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: mode === "device",
        ...(mode === "device" ? { systemAudio: "include", windowAudio: "system" } : {})
      });
      if (mode === "microphone") {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
        mic.getAudioTracks().forEach((track) => localStream.addTrack(track));
      }
      captureHasAudio = localStream.getAudioTracks().some((track) => track.readyState === "live");
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = "detail";
        videoTrack.onended = () => stopLocal(true);
      }
      localStream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          captureHasAudio = localStream ? localStream.getAudioTracks().some((t) => t.readyState === "live") : false;
        };
      });
      if (!peerId || !ws || ws.readyState !== WebSocket.OPEN) {
        stopLocal(false);
        setStatus("Peer disconnected · reopen on both devices");
        return;
      }
      send({ type: "claim" });
      setStatus(captureHasAudio ? "Waiting to share screen and audio…" : "Waiting to share screen…");
    } catch (error) {
      stopLocal(false);
      setStatus(error.name === "NotAllowedError" ? "Capture permission cancelled" : "Capture failed: " + error.message);
    }
  });

  stopBtn.addEventListener("click", () => { stopLocal(true); setStatus("Sharing stopped"); });
  enableAudioBtn.addEventListener("click", async () => {
    video.muted = false;
    try { await video.play(); } catch (_) { setStatus("Tap play on the video to enable sound"); }
  });
  fileInput.addEventListener("change", () => sendFiles(fileInput.files));
  dropEl.addEventListener("click", (event) => {
    if (event.target === fileInput) return;
    if (dataChannel?.readyState === "open" && !sendingFiles) fileInput.click();
  });
  dropEl.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && dataChannel?.readyState === "open" && !sendingFiles) fileInput.click();
  });
  dropEl.addEventListener("dragover", (event) => { event.preventDefault(); dropEl.classList.add("drag"); });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("drag"));
  dropEl.addEventListener("drop", (event) => {
    event.preventDefault();
    dropEl.classList.remove("drag");
    if (dataChannel?.readyState === "open" && !sendingFiles) sendFiles(event.dataTransfer.files);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (!ws || ws.readyState !== WebSocket.OPEN) connect();
      else { try { ws.send("ping"); } catch (_) {} }
      if (sharing && pc && ["failed", "disconnected"].includes(pc.connectionState)) scheduleIceRestart(200);
    }
  });
  window.addEventListener("pageshow", () => { if (!ws || ws.readyState >= WebSocket.CLOSING) connect(); });
  window.addEventListener("online", () => {
    if (!ws || ws.readyState >= WebSocket.CLOSING) connect();
    if (sharing && pc) scheduleIceRestart(300);
  });
  window.addEventListener("beforeunload", () => {
    clearInterval(heartbeatTimer);
    clearInterval(statsTimer);
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
  });

  connect();
  startHeartbeat();
  statsTimer = setInterval(refreshQuality, 2500);
  update();
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Origin not allowed", { status: 403 });
      const id = env.ROOM.idFromName("one-public-projector-room");
      return env.ROOM.get(id).fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:"
        }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (typeof WebSocketRequestResponsePair !== "undefined" && typeof ctx.setWebSocketAutoResponse === "function") {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const url = new URL(request.url);
    let clientId = url.searchParams.get("id") || "";
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) clientId = crypto.randomUUID();

    const active = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
    const replaced = active.find((socket) => socket.deserializeAttachment()?.id === clientId);
    const peers = active.filter((socket) => socket !== replaced);
    if (peers.length >= 2) return new Response("This projector room is full (2 devices maximum).", { status: 409 });

    const previousSession = replaced?.deserializeAttachment() || null;
    const requestedRole = url.searchParams.get("role") === "presenter" ? "presenter" : "viewer";
    const anotherPresenter = peers.some((socket) => socket.deserializeAttachment()?.role === "presenter");
    const wantsPresenter = previousSession?.role === "presenter" || requestedRole === "presenter";
    const session = { id: clientId, role: wantsPresenter && !anotherPresenter ? "presenter" : "viewer" };

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    if (replaced) {
      try { replaced.close(4001, "Connection replaced"); } catch (_) {}
    }

    const peerSessions = peers.map((socket) => socket.deserializeAttachment() || {});
    server.send(JSON.stringify({
      type: "welcome",
      id: clientId,
      role: session.role,
      peers: peerSessions.map((peer) => peer.id).filter(Boolean),
      peerRole: peerSessions[0]?.role || "viewer",
      presenterActive: session.role === "presenter" || peerSessions.some((peer) => peer.role === "presenter")
    }));

    for (const peer of peers) {
      try {
        peer.send(JSON.stringify({
          type: replaced ? "peer-reconnected" : "peer-joined",
          id: clientId,
          role: session.role
        }));
      } catch (_) {}
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (raw === "ping") { try { ws.send("pong"); } catch (_) {} return; }
    if (typeof raw !== "string" || raw.length > 200000) {
      try { ws.close(1009, "Message too large or invalid"); } catch (_) {}
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    const session = ws.deserializeAttachment() || {};
    const sockets = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
    const peers = sockets.filter((socket) => socket !== ws);

    if (message.type === "claim") {
      if (!peers.length) {
        ws.send(JSON.stringify({ type: "claim-denied", reason: "Wait for the second device to connect" }));
        return;
      }
      const alreadySharing = peers.some((peer) => peer.deserializeAttachment()?.role === "presenter");
      if (alreadySharing) {
        ws.send(JSON.stringify({ type: "claim-denied", reason: "The other device is already sharing" }));
        return;
      }
      session.role = "presenter";
      ws.serializeAttachment(session);
      ws.send(JSON.stringify({ type: "claim-ok" }));
      for (const peer of peers) {
        try { peer.send(JSON.stringify({ type: "presenter-started" })); } catch (_) {}
      }
      return;
    }

    if (message.type === "release") {
      if (session.role === "presenter") {
        session.role = "viewer";
        ws.serializeAttachment(session);
        for (const peer of peers) {
          try { peer.send(JSON.stringify({ type: "presenter-stopped" })); } catch (_) {}
        }
      }
      return;
    }

    if (!["offer", "answer", "candidate"].includes(message.type)) return;
    if (typeof message.to !== "string" || !message.payload || typeof message.payload !== "object") return;
    const target = peers.find((peer) => peer.deserializeAttachment()?.id === message.to);
    if (!target) { try { ws.send(JSON.stringify({ type: "peer-missing" })); } catch (_) {} return; }
    try {
      target.send(JSON.stringify({ type: message.type, from: session.id, payload: message.payload }));
    } catch (_) {
      try { ws.send(JSON.stringify({ type: "peer-missing" })); } catch (_) {}
    }
  }

  webSocketClose(ws) {
    const session = ws.deserializeAttachment() || {};
    const sockets = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
    if (sockets.some((socket) => socket.deserializeAttachment()?.id === session.id)) return;
    for (const peer of sockets) {
      try {
        if (session.role === "presenter") peer.send(JSON.stringify({ type: "presenter-stopped" }));
        peer.send(JSON.stringify({ type: "peer-left", id: session.id }));
      } catch (_) {}
    }
  }

  webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch (_) {}
  }
}
