import { createServer } from "http";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const rooms = new Map();
const RESULTS_PATH = path.join(process.cwd(), "results.json");
const PLAYERS_PATH = path.join(process.cwd(), "players.json");
const CONNECTIONS_PATH = path.join(process.cwd(), "connections.json");
const JWT_SECRET = process.env.JWT_SECRET || "jwt-secret";

function loadResults() {
  try {
    if (fs.existsSync(RESULTS_PATH)) {
      const raw = fs.readFileSync(RESULTS_PATH, "utf8");
      return JSON.parse(raw || "[]");
    }
  } catch (e) {
    console.error("Failed to load results", e);
  }
  return [];
}

function saveResult(entry) {
  try {
    const all = loadResults();
    all.push(entry);
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save result", e);
  }
}

function loadPlayers() {
  try {
    if (fs.existsSync(PLAYERS_PATH)) {
      const raw = fs.readFileSync(PLAYERS_PATH, "utf8");
      return JSON.parse(raw || "[]");
    }
  } catch (e) {
    console.error("Failed to load players", e);
  }
  return [];
}

function savePlayers(list) {
  try {
    fs.writeFileSync(PLAYERS_PATH, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save players", e);
  }
}

function loadConnections() {
  try {
    if (fs.existsSync(CONNECTIONS_PATH)) {
      const raw = fs.readFileSync(CONNECTIONS_PATH, "utf8");
      return JSON.parse(raw || "[]");
    }
  } catch (e) {
    console.error("Failed to load connections", e);
  }
  return [];
}

function saveConnections(list) {
  try {
    fs.writeFileSync(CONNECTIONS_PATH, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save connections", e);
  }
}

function getPlayers() {
  return loadPlayers();
}

function findPlayer(username) {
  const players = getPlayers();
  return players.find((player) => player.username === username);
}

function createPlayer(username, password, role = "player") {
  const players = getPlayers();
  if (players.some((player) => player.username === username)) {
    return null;
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const newPlayer = { username, passwordHash, role, lastRoomId: null, lastColor: null };
  players.push(newPlayer);
  savePlayers(players);
  return newPlayer;
}

function ensureOrganizerAccount() {
  const players = getPlayers();
  const existing = players.find((player) => player.role === "organizer");
  if (existing) {
    return;
  }
  const username = process.env.ORGANIZER_USER || "admin";
  const password = process.env.ORGANIZER_PASS || "admin";
  console.log(`Creating default organizer account ${username}`);
  createPlayer(username, password, "organizer");
}

function generateToken(user) {
  return jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function serializeRooms() {
  const out = [];
  for (const room of rooms.values()) {
    out.push({
      id: room.id,
      status: room.status,
      whiteName: room.white.name || null,
      blackName: room.black.name || null,
    });
  }
  return out;
}

const connections = new Map(loadConnections().map((entry) => [entry.username, entry]));

function persistConnections() {
  saveConnections(Array.from(connections.values()));
}

function parseJsonBody(req, onComplete) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      onComplete(null, JSON.parse(body || "{}"));
    } catch (e) {
      onComplete(e);
    }
  });
}

function getAuthPayload(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return verifyToken(token);
}

function requireOrganizer(req, res) {
  const payload = getAuthPayload(req);
  if (!payload || typeof payload !== "object" || payload.role !== "organizer") {
    writeJson(res, 403, { error: "forbidden" });
    return null;
  }
  return payload;
}

function emitRoomsList() {
  io.emit("roomsList", serializeRooms());
}

function createRoom(roomId, playerName, baseTime, increment, socketId) {
  const chess = new Chess();
  const room = {
    id: roomId,
    chess,
    status: "waiting",
    white: { id: socketId, name: playerName },
    black: { id: null, name: null },
    spectators: [],
    baseTime,
    increment,
    whiteTime: baseTime,
    blackTime: baseTime,
    resultText: null,
    timer: null,
  };
  rooms.set(roomId, room);
  return room;
}

function getRoomState(room) {
  return {
    roomId: room.id,
    status: room.status,
    whiteName: room.white.name || "White",
    blackName: room.black.name || "Black",
    fen: room.chess.fen(),
    history: room.chess.history(),
    currentTurn: room.chess.turn(),
    whiteTime: room.whiteTime,
    blackTime: room.blackTime,
    increment: room.increment || 0,
    resultText: room.resultText,
  };
}

function startRoomTimer(room) {
  if (room.timer || room.status !== "playing") {
    return;
  }

  room.timer = setInterval(() => {
    if (room.status !== "playing") {
      return;
    }

    if (room.chess.turn() === "w") {
      room.whiteTime -= 1;
      if (room.whiteTime <= 0) {
        room.whiteTime = 0;
        room.status = "finished";
        room.resultText = `${room.black.name || "Black"} wins on time`;
        stopRoomTimer(room);
        saveResult({ roomId: room.id, reason: "time", result: room.resultText, finishedAt: new Date().toISOString() });
      }
    } else {
      room.blackTime -= 1;
      if (room.blackTime <= 0) {
        room.blackTime = 0;
        room.status = "finished";
        room.resultText = `${room.white.name || "White"} wins on time`;
        stopRoomTimer(room);
        saveResult({ roomId: room.id, reason: "time", result: room.resultText, finishedAt: new Date().toISOString() });
      }
    }

    io.to(room.id).emit("roomUpdate", getRoomState(room));
  }, 1000);
}

function stopRoomTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.white.id === socketId || room.black.id === socketId) {
      return room;
    }
  }
  return null;
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || null;
  if (token) {
    const payload = verifyToken(token);
    if (payload && typeof payload === "object") {
      socket.data.user = payload;
    }
  }
  next();
});

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId, playerName, baseTime, increment, spectator }) => {
    // support spectator join: pass { spectator: true }
    const isSpectator = spectator === true;
    if ((!playerName && !socket.data.user?.username) || (playerName && typeof playerName !== "string")) {
      socket.emit("errorMessage", "Enter a valid player name.");
      return;
    }

    if (!roomId || typeof roomId !== "string") {
      socket.emit("errorMessage", "Provide a valid room id.");
      return;
    }

    const authUser = socket.data.user?.username;
    const effectiveName = authUser || playerName;
    let room = rooms.get(roomId);
    let playerColor = "white";

    if (!room) {
      room = createRoom(roomId, effectiveName, baseTime || 300, typeof increment === "number" ? increment : 0, socket.id);
      socket.join(roomId);
      playerColor = "white";
      emitRoomsList();
    } else {
      if (isSpectator) {
        room.spectators.push({ id: socket.id, name: effectiveName });
        socket.join(roomId);
        socket.emit("roomJoined", { roomId: room.id, playerColor: "spectator", ...getRoomState(room) });
        io.to(room.id).emit("roomUpdate", getRoomState(room));
        emitRoomsList();
        return;
      }

      if (room.white.name === effectiveName && !room.white.id) {
        room.white.id = socket.id;
        playerColor = "white";
        socket.join(roomId);
      } else if (room.black.name === effectiveName && !room.black.id) {
        room.black.id = socket.id;
        playerColor = "black";
        socket.join(roomId);
      } else {
        const alreadyWhite = room.white.id === socket.id;
        const alreadyBlack = room.black.id === socket.id;

        if (alreadyWhite || alreadyBlack) {
          playerColor = alreadyWhite ? "white" : "black";
          socket.join(roomId);
        } else if (!room.black.id) {
          room.black.id = socket.id;
          room.black.name = effectiveName;
          playerColor = "black";
          socket.join(roomId);
          room.status = "playing";
          room.resultText = null;
          room.whiteTime = room.baseTime;
          room.blackTime = room.baseTime;
          startRoomTimer(room);
          emitRoomsList();
        } else {
          socket.emit("errorMessage", "This room is full. Create a new match or join another room.");
          return;
        }
      }
    }

    if (authUser && playerColor !== "spectator") {
      const playerRecord = findPlayer(authUser);
      if (playerRecord) {
        playerRecord.lastRoomId = room.id;
        playerRecord.lastColor = playerColor;
        savePlayers(getPlayers().map((p) => (p.username === playerRecord.username ? playerRecord : p)));
        connections.set(playerRecord.username, { username: playerRecord.username, roomId: room.id, color: playerColor });
        persistConnections();
      }
    }

    socket.emit("roomJoined", {
      roomId: room.id,
      playerColor,
      ...getRoomState(room),
    });

    io.to(room.id).emit("roomUpdate", getRoomState(room));
    emitRoomsList();
  });

    socket.on("makeMove", ({ roomId, from, to, promotion }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("errorMessage", "Match not found.");
      return;
    }

    // Only assigned players may make moves
    if (room.white.id !== socket.id && room.black.id !== socket.id) {
      socket.emit("errorMessage", "Only players in the match can make moves.");
      return;
    }

    if (room.status !== "playing") {
      socket.emit("errorMessage", "The match is not active yet.");
      return;
    }

    const movingColor = room.chess.turn() === "w" ? "white" : "black";
    const move = room.chess.move({ from, to, promotion: promotion || "q" });
    if (!move) {
      socket.emit("errorMessage", "Illegal move.");
      return;
    }

    const bonus = typeof room.increment === "number" ? room.increment : 0;
    if (movingColor === "white") {
      room.whiteTime += bonus;
    } else {
      room.blackTime += bonus;
    }

    if (room.chess.isCheckmate()) {
      room.status = "finished";
      room.resultText = room.chess.turn() === "w"
        ? `${room.black.name || "Black"} wins by checkmate`
        : `${room.white.name || "White"} wins by checkmate`;
      stopRoomTimer(room);
      saveResult({ roomId: room.id, reason: "checkmate", result: room.resultText, finishedAt: new Date().toISOString(), white: room.white.name, black: room.black.name });
    }

    io.to(room.id).emit("roomUpdate", getRoomState(room));
  });

  socket.on("resign", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("errorMessage", "Match not found.");
      return;
    }

    const resigningIsWhite = room.white.id === socket.id;
    const resigningIsBlack = room.black.id === socket.id;
    if (!resigningIsWhite && !resigningIsBlack) {
      socket.emit("errorMessage", "Only players in the match can resign.");
      return;
    }

    if (room.status !== "playing") {
      socket.emit("errorMessage", "The match is not active.");
      return;
    }

    const winnerName = resigningIsWhite ? room.black.name || "Black" : room.white.name || "White";
    room.status = "finished";
    room.resultText = `${winnerName} wins by resignation`;
    stopRoomTimer(room);
    saveResult({ roomId: room.id, reason: "resignation", result: room.resultText, finishedAt: new Date().toISOString(), white: room.white.name, black: room.black.name });
    io.to(room.id).emit("roomUpdate", getRoomState(room));
  });

  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.white.id === socket.id) {
      room.white.id = null;
    }
    if (room.black.id === socket.id) {
      room.black.id = null;
    }

    if (room.white.id === null && room.black.id === null) {
      stopRoomTimer(room);
      rooms.delete(roomId);
      emitRoomsList();
      return;
    }

    room.status = "waiting";
    stopRoomTimer(room);
    io.to(room.id).emit("roomUpdate", getRoomState(room));
    emitRoomsList();
  });

  socket.on("disconnect", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) {
      return;
    }

    if (room.white.id === socket.id) {
      room.white.id = null;
    }
    if (room.black.id === socket.id) {
      room.black.id = null;
    }

    if (room.white.id === null && room.black.id === null) {
      stopRoomTimer(room);
      rooms.delete(room.id);
      emitRoomsList();
      return;
    }

    room.status = "waiting";
    stopRoomTimer(room);
    io.to(room.id).emit("roomUpdate", getRoomState(room));
    emitRoomsList();
  });

  socket.on("reconnectLastRoom", () => {
    if (!socket.data.user?.username) {
      socket.emit("errorMessage", "Authentication required to reconnect.");
      return;
    }
    const record = connections.get(socket.data.user.username);
    if (!record || !record.roomId) {
      socket.emit("errorMessage", "No previous room found.");
      return;
    }
    const room = rooms.get(record.roomId);
    if (!room) {
      socket.emit("errorMessage", "Previous room is no longer available.");
      return;
    }
    const username = socket.data.user.username;
    if (record.color === "white" && !room.white.id) {
      room.white.id = socket.id;
      socket.join(room.id);
    } else if (record.color === "black" && !room.black.id) {
      room.black.id = socket.id;
      socket.join(room.id);
    } else {
      socket.emit("errorMessage", "Unable to reconnect to the previous seat.");
      return;
    }
    socket.emit("roomJoined", { roomId: room.id, playerColor: record.color, ...getRoomState(room) });
    io.to(room.id).emit("roomUpdate", getRoomState(room));
  });

  socket.on("chatMessage", ({ roomId, author, message }) => {
    const payload = { author, message, at: new Date().toISOString() };
    io.to(roomId).emit("chatMessage", payload);
  });
});

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function writeJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(JSON.stringify(data));
}

function writeNoContent(res) {
  setCorsHeaders(res);
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end();
}

// Simple HTTP endpoint to list rooms
httpServer.on("request", (req, res) => {
  if (req.url && req.url.startsWith("/socket.io")) {
    return;
  }

  const filePath = path.join(__dirname, "dist", req.url === "/" ? "index.html" : req.url);
  const ext = path.extname(filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const contentType = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
    return;
  }

  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    writeNoContent(res);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && req.url === "/rooms") {
    writeJson(res, 200, serializeRooms());
    return;
  }

  if (req.method === "POST" && req.url === "/auth/register") {
    parseJsonBody(req, (err, payload) => {
      if (err) {
        writeJson(res, 400, { error: "invalid payload" });
        return;
      }
      const { username, password } = payload;
      if (!username || !password || typeof username !== "string" || typeof password !== "string") {
        writeJson(res, 400, { error: "username and password are required" });
        return;
      }
      const user = createPlayer(username.trim(), password, "player");
      if (!user) {
        writeJson(res, 409, { error: "username already exists" });
        return;
      }
      const token = generateToken(user);
      writeJson(res, 201, { token, username: user.username, role: user.role });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/auth/login") {
    parseJsonBody(req, (err, payload) => {
      if (err) {
        writeJson(res, 400, { error: "invalid payload" });
        return;
      }
      const { username, password } = payload;
      if (!username || !password || typeof username !== "string" || typeof password !== "string") {
        writeJson(res, 400, { error: "username and password are required" });
        return;
      }
      const user = findPlayer(username.trim());
      if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
        writeJson(res, 401, { error: "invalid credentials" });
        return;
      }
      const token = generateToken(user);
      writeJson(res, 200, { token, username: user.username, role: user.role });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/auth/me") {
    const payload = getAuthPayload(req);
    if (!payload || typeof payload !== "object") {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    writeJson(res, 200, { username: payload.username, role: payload.role });
    return;
  }

  if (req.method === "GET" && req.url === "/player/history") {
    const payload = getAuthPayload(req);
    if (!payload || typeof payload !== "object") {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const username = payload.username;
    const results = loadResults().filter((game) => game.white === username || game.black === username);
    writeJson(res, 200, results);
    return;
  }

  if (req.url && req.url.startsWith("/organizer/")) {
    const authPayload = requireOrganizer(req, res);
    if (!authPayload) {
      return;
    }

    if (req.method === "POST" && req.url === "/organizer/start-round") {
      parseJsonBody(req, (err, payload) => {
        if (err) {
          writeJson(res, 400, { error: "invalid payload" });
          return;
        }

        let players = Array.isArray(payload.players) ? payload.players.filter((p) => typeof p === "string") : [];
        const baseTime = typeof payload.baseTime === "number" ? payload.baseTime : 300;
        const mode = payload.mode || "sequential";

        players = players.map((p) => p.trim()).filter(Boolean);

        if (mode === "random") {
          for (let i = players.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [players[i], players[j]] = [players[j], players[i]];
          }
        }

        const results = loadResults();
        const scores = {};
        const playedPairs = new Set();
        const byeHistory = new Map();

        for (const r of results) {
          if (r.white && r.black) {
            const key = `${r.white}::${r.black}`;
            playedPairs.add(key);
            playedPairs.add(`${r.black}::${r.white}`);
          }
          if (r.white && !r.black) {
            byeHistory.set(r.white, (byeHistory.get(r.white) || 0) + 1);
          }
          if (r.black && !r.white) {
            byeHistory.set(r.black, (byeHistory.get(r.black) || 0) + 1);
          }
          if (r.result && typeof r.result === "string" && r.white && r.black) {
            const w = r.white;
            const b = r.black;
            if (r.result.includes(w) && !r.result.includes("draw")) {
              scores[w] = (scores[w] || 0) + 1;
              scores[b] = (scores[b] || 0) + 0;
            } else if (r.result.includes(b) && !r.result.includes("draw")) {
              scores[b] = (scores[b] || 0) + 1;
              scores[w] = (scores[w] || 0) + 0;
            } else {
              scores[w] = (scores[w] || 0) + 0.5;
              scores[b] = (scores[b] || 0) + 0.5;
            }
          }
        }

        const sortedPlayers = [...players].sort((a, b) => {
          const scoreDiff = (scores[b] || 0) - (scores[a] || 0);
          if (scoreDiff !== 0) return scoreDiff;
          return a.localeCompare(b);
        });

        const created = [];
        const used = new Set();

        const assignBye = () => {
          const candidates = [...sortedPlayers].filter((player) => !used.has(player));
          candidates.sort((a, b) => {
            const aBye = byeHistory.get(a) || 0;
            const bBye = byeHistory.get(b) || 0;
            if (aBye !== bBye) return aBye - bBye;
            return (scores[a] || 0) - (scores[b] || 0);
          });
          return candidates[0] || null;
        };

        if (mode === "swiss" && sortedPlayers.length % 2 === 1) {
          const byePlayer = assignBye();
          if (byePlayer) {
            used.add(byePlayer);
            const rid = Math.random().toString(36).slice(2, 8).toUpperCase();
            const room = createRoom(rid, byePlayer, baseTime, null);
            room.black.name = "BYE";
            room.status = "finished";
            room.resultText = `${byePlayer} receives a bye`;
            rooms.set(rid, room);
            created.push({ roomId: rid, white: byePlayer, black: null, bye: true });
          }
        }

        const pairPlayer = (player) => {
          const candidates = sortedPlayers.filter((opponent) => opponent !== player && !used.has(opponent));
          candidates.sort((a, b) => {
            const aScore = scores[a] || 0;
            const bScore = scores[b] || 0;
            if (aScore !== bScore) return Math.abs((scores[player] || 0) - aScore) - Math.abs((scores[player] || 0) - bScore);
            return a.localeCompare(b);
          });
          const opponent = candidates.find((opponent) => !playedPairs.has(`${player}::${opponent}`));
          return opponent || candidates[0] || null;
        };

        for (const player of sortedPlayers) {
          if (used.has(player)) continue;
          const opponent = pairPlayer(player);
          if (!opponent) {
            used.add(player);
            const rid = Math.random().toString(36).slice(2, 8).toUpperCase();
            const room = createRoom(rid, player, baseTime, null);
            room.black.name = "BYE";
            room.status = "finished";
            room.resultText = `${player} receives a bye`;
            rooms.set(rid, room);
            created.push({ roomId: rid, white: player, black: null, bye: true });
            continue;
          }
          used.add(player);
          used.add(opponent);
          const rid = Math.random().toString(36).slice(2, 8).toUpperCase();
          const room = createRoom(rid, player, baseTime, null);
          room.black.name = opponent;
          rooms.set(rid, room);
          created.push({ roomId: rid, white: player, black: opponent });
        }

        if (mode !== "swiss") {
          const pairs = [];
          for (let i = 0; i < players.length; i += 2) {
            const a = players[i];
            const b = players[i + 1] || null;
            pairs.push([a, b]);
          }
          created.length = 0;
          for (const [a, b] of pairs) {
            const rid = Math.random().toString(36).slice(2, 8).toUpperCase();
            const room = createRoom(rid, a || "Player", baseTime, null);
            if (b) {
              room.black.name = b;
            }
            rooms.set(rid, room);
            created.push({ roomId: rid, white: a, black: b });
          }
        }

        emitRoomsList();
        writeJson(res, 200, { created });
      });
      return;
    }

    if (req.method === "POST" && req.url === "/organizer/stop-round") {
      parseJsonBody(req, (err, payload) => {
        if (err) {
          writeJson(res, 400, { error: "invalid payload" });
          return;
        }
        const roomIds = Array.isArray(payload.roomIds) ? payload.roomIds : [];
        for (const rid of roomIds) {
          const room = rooms.get(rid);
          if (!room) continue;
          room.status = "finished";
          room.resultText = "Stopped by organizer";
          stopRoomTimer(room);
          saveResult({ roomId: room.id, reason: "stopped", result: room.resultText, finishedAt: new Date().toISOString(), white: room.white.name, black: room.black.name });
          io.to(room.id).emit("roomUpdate", getRoomState(room));
        }
        emitRoomsList();
        writeJson(res, 200, { stopped: roomIds });
      });
      return;
    }

    if (req.method === "GET" && req.url === "/organizer/results") {
      const results = loadResults();
      writeJson(res, 200, results);
      return;
    }

    if (req.method === "GET" && req.url === "/organizer/dashboard") {
      const data = {
        rooms: Array.from(rooms.values()).map((r) => ({ id: r.id, status: r.status, white: r.white.name, black: r.black.name, fen: r.chess.fen(), whiteTime: r.whiteTime, blackTime: r.blackTime })),
        results: loadResults(),
      };
      writeJson(res, 200, data);
      return;
    }

    if (req.method === "GET" && req.url === "/organizer/printable") {
      const rows = Array.from(rooms.values())
        .map((r) => `<tr><td>${r.id}</td><td>${r.white.name || ""}</td><td>${r.black.name || ""}</td><td>${r.status}</td></tr>`)
        .join("");
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pairings</title></head><body><h1>Pairings</h1><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>Room</th><th>White</th><th>Black</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
  }

  if (req.method === "GET" && req.headers.accept && req.headers.accept.includes("text/html")) {
    const indexPath = path.join(__dirname, "dist", "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(indexPath));
      return;
    }
  }

  // allow other requests to pass through (e.g. socket.io)
});

ensureOrganizerAccount();
const PORT = process.env.PORT || 4000;
httpServer.on("error", (error) => {
  console.error("HTTP server error:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

// Graceful shutdown for Render and container environments
function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully.`);
  try {
    // stop accepting new connections
    httpServer.close(() => {
      console.log('HTTP server closed.');
      try {
        io.close(() => {
          console.log('Socket.IO closed.');
          persistConnections();
          process.exit(0);
        });
      } catch (e) {
        console.error('Error closing Socket.IO:', e);
        persistConnections();
        process.exit(1);
      }
    });
    // force exit after timeout
    setTimeout(() => {
      console.error('Shutdown timed out, forcing exit.');
      persistConnections();
      process.exit(1);
    }, 10000).unref();
  } catch (e) {
    console.error('Error during graceful shutdown:', e);
    persistConnections();
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Multiplayer server running on port ${PORT}`);
});
