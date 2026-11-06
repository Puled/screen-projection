
import { DurableObject } from "cloudflare:workers";

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Screen Projector</title>
<style>
  body{font:16px system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;color:#161616}
  button{font:inherit;padding:10px 16px;margin:8px 8px 8px 0;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  video{display:block;width:100%;max-height:78vh;background:#111;margin-top:16px}
  #status{padding:10px 0;color:#555}
</style>
</head>
<body>
<h2>Screen Projector</h2>
<div id="status">Connecting...</div>
<button id="share" disabled>Share this screen</button>
<button id="stop" disabled>Stop sharing</button>
<div id="count">Connected devices: 1 / 2</div>
<video id="screen" autoplay playsinline controls></video>
<script>
(() => {
  const statusEl = document.getElementById("status");
  const countEl = document.getElementById("count");
  const shareBtn = document.getElementById("share");
  const stopBtn = document.getElementById("stop");
  const video = document.getElementById("screen");
  let ws = null, myId = null, peerId = null, pc = null;
  let localStream = null, pendingCandidates = [], busy = false, sharing = false, remoteSharing = false;

  const setStatus = (s) => { statusEl.textContent = s; };
  const send = (message) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const update = () => {
    countEl.textContent = "Connected devices: " + (peerId ? "2" : "1") + " / 2";
    shareBtn.disabled = !peerId || !ws || ws.readyState !== WebSocket.OPEN || busy || sharing || remoteSharing;
    stopBtn.disabled = !sharing;
  };

  function closePeer(clearCandidates = true) {
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (clearCandidates) pendingCandidates = [];
    video.srcObject = null;
  }

  function stopLocal(sendRelease) {
    if (sendRelease) send({ type: "release" });
    if (localStream) {
      localStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      localStream = null;
    }
    sharing = false;
    busy = false;
    closePeer();
    update();
  }

  function makePeerConnection() {
    const connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    connection.onicecandidate = (event) => {
      if (event.candidate && peerId) {
        send({ type: "candidate", to: peerId, payload: event.candidate.toJSON() });
      }
    };
    connection.ontrack = (event) => {
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      video.play().catch(() => {});
      setStatus("Receiving screen.");
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected") setStatus(sharing ? "Sharing screen." : "Screen connected.");
      if (connection.connectionState === "failed") setStatus("Connection failed. Try again or use a different network.");
    };
    return connection;
  }

  async function flushCandidates() {
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingCandidates.splice(0);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch (e) { console.warn("ICE candidate:", e); }
    }
  }

  async function handleSignal(message) {
    if (message.type === "offer") {
      closePeer(false);
      pc = makePeerConnection();
      await pc.setRemoteDescription(message.payload);
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", to: message.from, payload: pc.localDescription });
      setStatus("Connecting to the shared screen...");
    } else if (message.type === "answer") {
      if (!pc) return;
      await pc.setRemoteDescription(message.payload);
      await flushCandidates();
      setStatus("Connecting to the projector...");
    } else if (message.type === "candidate") {
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(message.payload); } catch (e) { console.warn("ICE candidate:", e); }
      } else {
        pendingCandidates.push(message.payload);
      }
    }
  }

  async function handleMessage(message) {
    if (message.type === "welcome") {
      myId = message.id;
      peerId = (message.peers || [])[0] || null;
      remoteSharing = !!message.presenterActive;
      setStatus(!peerId ? "Waiting for the second device to open this page..." : remoteSharing ? "The other device is sharing." : "Both devices are connected. Start sharing on one device.");
      update();
      return;
    }
    if (message.type === "peer-joined") {
      peerId = message.id;
      remoteSharing = false;
      setStatus("Both devices are connected. Start sharing on one device.");
      update();
      return;
    }
    if (message.type === "peer-left") {
      if (message.id === peerId) {
        peerId = null;
        stopLocal(true);
        remoteSharing = false;
        setStatus("The other device disconnected. Waiting for another device...");
      }
      update();
      return;
    }
    if (message.type === "claim-ok") {
      remoteSharing = false;
      busy = false;
      sharing = true;
      update();
      try {
        closePeer();
        pc = makePeerConnection();
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "offer", to: peerId, payload: pc.localDescription });
        setStatus("Sharing screen. The other device is connecting...");
      } catch (e) {
        console.error(e);
        setStatus("Could not start the connection: " + e.message);
        stopLocal(true);
      }
      return;
    }
    if (message.type === "claim-denied") {
      remoteSharing = true;
      stopLocal(false);
      setStatus(message.reason || "The other device is already sharing.");
      return;
    }
    if (message.type === "presenter-started") {
      remoteSharing = true;
      update();
      setStatus("The other device is starting screen sharing...");
      return;
    }
    if (message.type === "presenter-stopped") {
      remoteSharing = false;
      closePeer();
      update();
      if (!sharing) setStatus("Screen sharing stopped. You can start a new session.");
      return;
    }
    if (message.type === "peer-missing") {
      setStatus("The other device is no longer connected. Refresh both devices to reconnect.");
      return;
    }
    if (["offer", "answer", "candidate"].includes(message.type) && message.from === peerId) {
      try { await handleSignal(message); }
      catch (e) { console.error(e); setStatus("WebRTC error: " + e.message); }
    }
  }

  shareBtn.addEventListener("click", async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setStatus("Screen sharing is not supported by this browser. Try desktop Chrome or Edge.");
      return;
    }
    busy = true;
    update();
    try {
      // Must be called directly from the button click so the browser can show its screen picker.
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false
      });
      if (!peerId || !ws || ws.readyState !== WebSocket.OPEN) {
        stopLocal(false);
        setStatus("The other device disconnected. Reopen this page on both devices.");
        return;
      }
      const track = localStream.getVideoTracks()[0];
      if (track) track.onended = () => stopLocal(true);
      send({ type: "claim" });
      setStatus("Waiting to start sharing...");
    } catch (e) {
      stopLocal(false);
      setStatus(e.name === "NotAllowedError" ? "Screen sharing was cancelled." : "Screen capture error: " + e.message);
    }
  });

  stopBtn.addEventListener("click", () => {
    stopLocal(true);
    setStatus("Screen sharing stopped.");
  });

  function connect() {
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(scheme + location.host + "/ws");
    ws.onopen = () => setStatus("Connected. Waiting for the other device...");
    ws.onmessage = async (event) => {
      try { await handleMessage(JSON.parse(event.data)); }
      catch (e) { console.error(e); setStatus("Signaling error: " + e.message); }
    };
    ws.onclose = () => {
      stopLocal(false);
      peerId = null;
      update();
      setStatus("Disconnected from the server. Refresh this page to reconnect.");
    };
    ws.onerror = () => setStatus("WebSocket connection error.");
  }

  if (!window.isSecureContext) {
    setStatus("This page needs HTTPS for browser screen sharing.");
  }
  connect();
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
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
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

// One globally shared room: exactly two connected browsers at a time.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const active = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    if (active.length >= 2) return new Response("This projector room is full (2 devices maximum).", { status: 409 });

    const peers = active.map((ws) => ws.deserializeAttachment()?.id).filter(Boolean);
    const presenterActive = active.some((ws) => ws.deserializeAttachment()?.role === "presenter");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const session = { id: crypto.randomUUID(), role: "viewer" };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    server.send(JSON.stringify({ type: "welcome", id: session.id, peers, presenterActive }));
    for (const peer of active) {
      try { peer.send(JSON.stringify({ type: "peer-joined", id: session.id })); } catch (_) {}
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 200000) {
      try { ws.close(1009, "Message too large or invalid"); } catch (_) {}
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    const session = ws.deserializeAttachment() || {};
    const sockets = this.ctx.getWebSockets().filter((peer) => peer.readyState === WebSocket.OPEN);
    const peers = sockets.filter((peer) => peer !== ws);

    if (message.type === "claim") {
      if (!peers.length) {
        ws.send(JSON.stringify({ type: "claim-denied", reason: "Wait for the second device to connect first." }));
        return;
      }
      const alreadySharing = sockets.some((peer) => peer !== ws && peer.deserializeAttachment()?.role === "presenter");
      if (alreadySharing) {
        ws.send(JSON.stringify({ type: "claim-denied", reason: "The other device is already sharing." }));
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
    if (!target) {
      ws.send(JSON.stringify({ type: "peer-missing" }));
      return;
    }
    try {
      target.send(JSON.stringify({ type: message.type, from: session.id, payload: message.payload }));
    } catch (_) {
      ws.send(JSON.stringify({ type: "peer-missing" }));
    }
  }

  webSocketClose(ws) {
    const session = ws.deserializeAttachment() || {};
    const peers = this.ctx.getWebSockets().filter((peer) => peer !== ws && peer.readyState === WebSocket.OPEN);
    for (const peer of peers) {
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
