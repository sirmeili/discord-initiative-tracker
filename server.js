import { createServer } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Load optional .env file without requiring the dotenv package
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !line.trim().startsWith('#')) {
      const key = match[1];
      const val = (match[2] || '').replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ============================================================================
// Lightweight Native RFC 6455 WebSocket Implementation (Zero npm dependencies)
// ============================================================================
const wsClients = new Set();

function encodeWsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const byte0 = buffer[offset];
    const byte1 = buffer[offset + 1];
    const opcode = byte0 & 0x0f;
    const isMasked = Boolean(byte1 & 0x80);
    let payloadLen = byte1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    const totalFrameLen = headerLen + maskLen + payloadLen;
    if (offset + totalFrameLen > buffer.length) break;

    if (opcode === 0x8) {
      // Close frame
      messages.push({ type: 'close' });
      offset += totalFrameLen;
      break;
    }

    if (opcode === 0x1) {
      const payloadStart = offset + headerLen + maskLen;
      const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLen));
      if (isMasked) {
        const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }
      messages.push({ type: 'text', data: payload.toString('utf8') });
    }

    offset += totalFrameLen;
  }

  return { messages, remaining: buffer.subarray(offset) };
}

// ============================================================================
// Multi-Room Encounter State Store (keyed by Discord instanceId or room code)
// ============================================================================
const rooms = new Map();

function createRoomState(roomId) {
  return {
    roomId,
    dmUserId: null,
    dmName: null,
    combatStarted: false,
    round: 1,
    activeTurnIndex: 0,
    combatants: [],
    lastNotification: null
  };
}

function getRoom(roomId) {
  const id = roomId || 'default-tavern';
  if (!rooms.has(id)) {
    rooms.set(id, createRoomState(id));
  }
  return rooms.get(id);
}

/**
 * Sort combatants in standard D&D 5e initiative order:
 * 1. Highest total initiative first
 * 2. Tie-breaker: highest DEX modifier first
 * 3. Tie-breaker: players before NPCs, then alphabetical
 * Combatants who haven't rolled yet (initiative === null) go to the bottom.
 */
function sortCombatants(room) {
  const currentActiveId = room.combatants[room.activeTurnIndex]?.id || null;

  room.combatants.sort((a, b) => {
    const aRolled = a.initiative !== null && a.initiative !== undefined;
    const bRolled = b.initiative !== null && b.initiative !== undefined;
    if (aRolled && !bRolled) return -1;
    if (!aRolled && bRolled) return 1;
    if (!aRolled && !bRolled) return a.name.localeCompare(b.name);

    if (b.initiative !== a.initiative) {
      return b.initiative - a.initiative;
    }
    if ((b.dexMod || 0) !== (a.dexMod || 0)) {
      return (b.dexMod || 0) - (a.dexMod || 0);
    }
    if (a.isNPC !== b.isNPC) {
      return a.isNPC ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  if (room.combatStarted && currentActiveId) {
    const newIdx = room.combatants.findIndex((c) => c.id === currentActiveId);
    room.activeTurnIndex = newIdx >= 0 ? newIdx : 0;
  }
}

function getTurnOrderContext(room) {
  const rolled = room.combatants.filter(
    (c) => c.initiative !== null && c.initiative !== undefined && (c.hp === null || c.hp > 0)
  );
  if (rolled.length === 0 || !room.combatStarted) {
    return { activeCombatant: null, onDeckCombatant: null };
  }
  const activeCombatant = room.combatants[room.activeTurnIndex] || null;
  let onDeckCombatant = null;
  if (room.combatants.length > 1) {
    const nextIdx = (room.activeTurnIndex + 1) % room.combatants.length;
    onDeckCombatant = room.combatants[nextIdx];
  }
  return { activeCombatant, onDeckCombatant };
}

function broadcastRoom(roomId, extraEvent = null) {
  const room = getRoom(roomId);
  const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);

  const payload = encodeWsFrame(
    JSON.stringify({
      type: 'STATE_UPDATE',
      state: room,
      activeCombatantId: activeCombatant?.id || null,
      onDeckCombatantId: onDeckCombatant?.id || null,
      event: extraEvent
    })
  );

  for (const client of wsClients) {
    if (!client.destroyed && client.roomId === room.roomId) {
      client.write(payload);
    }
  }
}

function handleClientMessage(socket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const roomId = msg.roomId || socket.roomId || 'default-tavern';
  socket.roomId = roomId;
  const room = getRoom(roomId);

  switch (msg.type) {
    case 'JOIN_ROOM': {
      const { userId, username, characterName, avatar, role } = msg;
      socket.userId = userId;

      if (role === 'dm') {
        room.dmUserId = userId;
        room.dmName = characterName || username || 'Dungeon Master';
      } else if (room.dmUserId === userId && role === 'player') {
        room.dmUserId = null;
        room.dmName = null;
      }

      if (role !== 'dm') {
        let existing = room.combatants.find((c) => c.ownerId === userId && !c.isNPC);
        if (!existing) {
          existing = {
            id: `pc_${userId}`,
            ownerId: userId,
            name: characterName || username || 'Adventurer',
            playerName: username || 'Player',
            avatar: avatar || null,
            isNPC: false,
            initiative: null,
            rawRoll: null,
            dexMod: 0,
            hp: 30,
            maxHp: 30,
            ac: 15,
            conditions: []
          };
          room.combatants.push(existing);
        } else if (characterName) {
          existing.name = characterName;
        }
        sortCombatants(room);
      }

      broadcastRoom(roomId, {
        kind: 'USER_JOINED',
        userId,
        name: characterName || username
      });
      break;
    }

    case 'SUBMIT_INITIATIVE': {
      const { combatantId, ownerId, rawRoll, dexMod, manualTotal, name, hp, maxHp, ac } = msg;
      let target = room.combatants.find(
        (c) => c.id === combatantId || (!c.isNPC && c.ownerId === ownerId)
      );

      if (!target && ownerId) {
        target = {
          id: `pc_${ownerId}`,
          ownerId,
          name: name || 'Adventurer',
          playerName: name || 'Player',
          avatar: null,
          isNPC: false,
          initiative: null,
          rawRoll: null,
          dexMod: 0,
          hp: hp ?? 30,
          maxHp: maxHp ?? 30,
          ac: ac ?? 15,
          conditions: []
        };
        room.combatants.push(target);
      }

      if (target) {
        const mod = Number(dexMod) || 0;
        target.dexMod = mod;
        if (name) target.name = name;
        if (hp !== undefined) target.hp = Number(hp);
        if (maxHp !== undefined) target.maxHp = Number(maxHp);
        if (ac !== undefined) target.ac = Number(ac);

        if (manualTotal !== undefined && manualTotal !== null && manualTotal !== '') {
          target.initiative = Number(manualTotal);
          target.rawRoll = null;
        } else {
          const d20 = Number(rawRoll) || Math.floor(Math.random() * 20) + 1;
          target.rawRoll = d20;
          target.initiative = d20 + mod;
        }

        sortCombatants(room);
        broadcastRoom(roomId, {
          kind: 'INITIATIVE_ROLLED',
          combatantId: target.id,
          name: target.name,
          initiative: target.initiative,
          rawRoll: target.rawRoll,
          dexMod: target.dexMod
        });
      }
      break;
    }

    case 'ADD_NPC': {
      const { name, initiative, dexMod, hp, maxHp, ac, count } = msg;
      const numToCreate = Math.min(Math.max(Number(count) || 1, 1), 10);
      const mod = Number(dexMod) || 0;

      for (let i = 0; i < numToCreate; i++) {
        const suffix = numToCreate > 1 ? ` #${i + 1}` : '';
        let initVal = null;
        let rawVal = null;

        if (initiative !== undefined && initiative !== null && initiative !== '') {
          initVal = Number(initiative);
        } else {
          rawVal = Math.floor(Math.random() * 20) + 1;
          initVal = rawVal + mod;
        }

        room.combatants.push({
          id: `npc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          ownerId: room.dmUserId,
          name: `${name || 'Goblin'}${suffix}`,
          playerName: 'DM (Monster/NPC)',
          avatar: null,
          isNPC: true,
          initiative: initVal,
          rawRoll: rawVal,
          dexMod: mod,
          hp: Number(hp) || 22,
          maxHp: Number(maxHp || hp) || 22,
          ac: Number(ac) || 13,
          conditions: []
        });
      }

      sortCombatants(room);
      broadcastRoom(roomId, { kind: 'NPC_ADDED', name });
      break;
    }

    case 'UPDATE_COMBATANT': {
      const { combatantId, updates } = msg;
      const target = room.combatants.find((c) => c.id === combatantId);
      if (target && updates) {
        if (updates.name !== undefined) target.name = updates.name;
        if (updates.initiative !== undefined) {
          target.initiative =
            updates.initiative === '' || updates.initiative === null
              ? null
              : Number(updates.initiative);
        }
        if (updates.dexMod !== undefined) target.dexMod = Number(updates.dexMod) || 0;
        if (updates.hp !== undefined) target.hp = Math.max(0, Number(updates.hp));
        if (updates.maxHp !== undefined) target.maxHp = Math.max(1, Number(updates.maxHp));
        if (updates.ac !== undefined) target.ac = Number(updates.ac) || 10;
        if (updates.conditions !== undefined) target.conditions = updates.conditions;

        sortCombatants(room);
        broadcastRoom(roomId, { kind: 'COMBATANT_UPDATED', combatantId });
      }
      break;
    }

    case 'REMOVE_COMBATANT': {
      const { combatantId } = msg;
      const idx = room.combatants.findIndex((c) => c.id === combatantId);
      if (idx !== -1) {
        room.combatants.splice(idx, 1);
        if (room.activeTurnIndex >= room.combatants.length) {
          room.activeTurnIndex = 0;
        }
        broadcastRoom(roomId, { kind: 'COMBATANT_REMOVED', combatantId });
      }
      break;
    }

    case 'NEXT_TURN': {
      if (room.combatants.length === 0) break;
      if (!room.combatStarted) {
        sortCombatants(room);
        room.combatStarted = true;
        room.round = 1;
        room.activeTurnIndex = 0;
      } else {
        room.activeTurnIndex += 1;
        if (room.activeTurnIndex >= room.combatants.length) {
          room.activeTurnIndex = 0;
          room.round += 1;
        }
      }

      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
      const turnEvent = {
        kind: 'TURN_CHANGED',
        round: room.round,
        activeCombatant,
        onDeckCombatant,
        timestamp: Date.now()
      };
      room.lastNotification = turnEvent;
      broadcastRoom(roomId, turnEvent);
      break;
    }

    case 'PREV_TURN': {
      if (!room.combatStarted || room.combatants.length === 0) break;
      room.activeTurnIndex -= 1;
      if (room.activeTurnIndex < 0) {
        room.activeTurnIndex = room.combatants.length - 1;
        room.round = Math.max(1, room.round - 1);
      }

      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
      const turnEvent = {
        kind: 'TURN_CHANGED',
        round: room.round,
        activeCombatant,
        onDeckCombatant,
        timestamp: Date.now()
      };
      room.lastNotification = turnEvent;
      broadcastRoom(roomId, turnEvent);
      break;
    }

    case 'PING_ACTIVE_PLAYER': {
      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
      if (activeCombatant) {
        const pingEvent = {
          kind: 'TURN_PING',
          round: room.round,
          activeCombatant,
          onDeckCombatant,
          customMessage: msg.customMessage || `The DM awaits your action, ${activeCombatant.name}!`,
          timestamp: Date.now()
        };
        broadcastRoom(roomId, pingEvent);
      }
      break;
    }

    case 'RESET_INITIATIVE': {
      room.combatStarted = false;
      room.round = 1;
      room.activeTurnIndex = 0;
      if (msg.clearRolls) {
        room.combatants.forEach((c) => {
          c.initiative = null;
          c.rawRoll = null;
        });
      }
      if (msg.removeNPCs) {
        room.combatants = room.combatants.filter((c) => !c.isNPC);
      }
      broadcastRoom(roomId, { kind: 'ENCOUNTER_RESET' });
      break;
    }
  }
}

// ============================================================================
// HTTP Server + WebSocket Upgrade Handler
// ============================================================================
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clientId: process.env.DISCORD_CLIENT_ID || null }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/token') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { code } = JSON.parse(body || '{}');
        const response = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID || '',
            client_secret: process.env.DISCORD_CLIENT_SECRET || '',
            grant_type: 'authorization_code',
            code: code || ''
          })
        });
        const data = await response.json();
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: data.access_token }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Token exchange failed' }));
      }
    });
    return;
  }

  // Serve static files from /public
  const safePath = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ].join('\r\n')
  );

  socket.roomId = 'default-tavern';
  wsClients.add(socket);

  // Immediately send initial room state
  const room = getRoom(socket.roomId);
  const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
  socket.write(
    encodeWsFrame(
      JSON.stringify({
        type: 'STATE_UPDATE',
        state: room,
        activeCombatantId: activeCombatant?.id || null,
        onDeckCombatantId: onDeckCombatant?.id || null,
        event: null
      })
    )
  );

  let recvBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    recvBuffer = Buffer.concat([recvBuffer, chunk]);
    const { messages, remaining } = decodeWsFrames(recvBuffer);
    recvBuffer = remaining;

    for (const m of messages) {
      if (m.type === 'close') {
        socket.end();
        wsClients.delete(socket);
        return;
      }
      if (m.type === 'text') {
        handleClientMessage(socket, m.data);
      }
    }
  });

  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n⚔️  D&D Initiative Tracker Server running at http://localhost:${PORT}`);
  console.log(`   Zero npm dependencies required! Open multiple browser tabs to test.\n`);
});
