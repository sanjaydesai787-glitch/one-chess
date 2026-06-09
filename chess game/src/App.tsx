import { useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import { io, type Socket } from "socket.io-client";

type RoomStatus = "waiting" | "playing" | "finished";
type PlayerColor = "white" | "black" | "spectator";

type MatchState = {
  roomId: string;
  status: RoomStatus;
  whiteName: string;
  blackName: string;
  fen: string;
  history: string[];
  currentTurn: "w" | "b";
  whiteTime: number;
  blackTime: number;
  increment: number;
  resultText: string | null;
};

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatMoveHistory(history: string[]) {
  const lines: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    const moveNumber = Math.floor(i / 2) + 1;
    const whiteMove = history[i];
    const blackMove = history[i + 1];
    lines.push(`${moveNumber}. ${whiteMove}${blackMove ? ` ${blackMove}` : ""}`);
  }
  return lines;
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function App() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [playerColor, setPlayerColor] = useState<PlayerColor | null>(null);
  const [statusMessage, setStatusMessage] = useState("Enter name and room to host or join a match.");
  const [matchStatus, setMatchStatus] = useState<RoomStatus>("waiting");
  const [roomsList, setRoomsList] = useState<Array<{id:string;status:string;whiteName:string|null;blackName:string|null}>>([]);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authRole, setAuthRole] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [registerUsername, setRegisterUsername] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [playerHistory, setPlayerHistory] = useState<any[]>([]);
  const [pairingMode, setPairingMode] = useState<"sequential" | "random" | "seeded" | "swiss">("sequential");
  const [seedValues, setSeedValues] = useState("");
  const [dashboardRooms, setDashboardRooms] = useState<any[]>([]);
  const [dashboardResults, setDashboardResults] = useState<any[]>([]);
  const [chatMessages, setChatMessages] = useState<{author:string;message:string;at:string}[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [organizerPlayers, setOrganizerPlayers] = useState("");
  const [organizerResults, setOrganizerResults] = useState<any[]>([]);
  const [whiteName, setWhiteName] = useState("White");
  const [blackName, setBlackName] = useState("Black");
  const isLoggedIn = !!authToken;
  const isAdmin = isLoggedIn && authRole === "organizer";
  const isPlayer = isLoggedIn && authRole === "player";
  const [fen, setFen] = useState("start");
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [currentTurn, setCurrentTurn] = useState<"w" | "b">("w");
  const [whiteTime, setWhiteTime] = useState(300);
  const [blackTime, setBlackTime] = useState(300);
  const [resultText, setResultText] = useState<string | null>(null);
  const [baseTime, setBaseTime] = useState(300);
  const [increment, setIncrement] = useState(2);
  const serverUrl = (import.meta.env.VITE_SERVER_URL as string) || "http://localhost:4000";

  function applyRoomState(payload: MatchState) {
    setMatchStatus(payload.status);
    setFen(payload.fen || "start");
    setMoveHistory(payload.history || []);
    setCurrentTurn(payload.currentTurn || "w");
    setWhiteName(payload.whiteName || "White");
    setBlackName(payload.blackName || "Black");
    setWhiteTime(typeof payload.whiteTime === "number" ? payload.whiteTime : baseTime);
    setBlackTime(typeof payload.blackTime === "number" ? payload.blackTime : baseTime);
    setIncrement(typeof payload.increment === "number" ? payload.increment : increment);
    setResultText(payload.resultText ?? null);
  }

  useEffect(() => {
    const storedToken = localStorage.getItem("chessToken");
    const storedUsername = localStorage.getItem("chessUsername");
    const storedRole = localStorage.getItem("chessRole");
    if (storedToken) {
      setAuthToken(storedToken);
      setAuthUsername(storedUsername || "");
      setAuthRole(storedRole || null);
      setPlayerName(storedUsername || "");
    }
  }, []);

  useEffect(() => {
    const socketUrl = (import.meta.env.VITE_SERVER_URL as string) || "http://localhost:4000";
    const socket = io(socketUrl, {
      transports: ["websocket"],
      auth: { token: authToken },
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setStatusMessage("Connected to tournament server.");
      fetchRooms().catch(() => {});
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setStatusMessage("Disconnected from server.");
    });

    socket.on("roomJoined", (payload: MatchState & { playerColor: PlayerColor }) => {
      setJoined(true);
      setRoomId(payload.roomId);
      setPlayerColor(payload.playerColor);
      applyRoomState(payload);
      setStatusMessage(`Joined room ${payload.roomId} as ${payload.playerColor}.`);
    });

    socket.on("roomUpdate", (payload: MatchState) => {
      applyRoomState(payload);
    });

    socket.on("roomsList", (list: any[]) => {
      setRoomsList(list || []);
    });

    socket.on("chatMessage", (m) => {
      setChatMessages((cur) => [...cur, m]);
    });

    socket.on("errorMessage", (message: string) => {
      setStatusMessage(message);
    });

    if (authToken && authRole === "player") {
      fetchPlayerHistory().catch(() => {});
    } else {
      setPlayerHistory([]);
    }

    return () => {
      socket.disconnect();
    };
  }, [authToken, authRole]);

  const moveHistoryLines = useMemo(() => formatMoveHistory(moveHistory), [moveHistory]);

  function handleJoinRoom(targetRoomId: string) {
    if (!authToken) {
      setStatusMessage("Please log in first to join a match.");
      return;
    }
    if (!playerName.trim()) {
      setStatusMessage("Enter your player name before joining a match.");
      return;
    }

    const normalizedRoomId = targetRoomId.trim().toUpperCase();
    if (!normalizedRoomId) {
      setStatusMessage("Please provide a valid match ID or create a new match.");
      return;
    }

    socketRef.current?.emit("joinRoom", {
      roomId: normalizedRoomId,
      playerName: playerName.trim(),
      baseTime,
      increment,
    });
  }

  function handleJoinRoomAsSpectator(targetRoomId: string) {
    if (!authToken) {
      setStatusMessage("Please log in first to spectate a match.");
      return;
    }
    if (!playerName.trim()) {
      setStatusMessage("Enter your player name before joining as a spectator.");
      return;
    }
    const normalizedRoomId = targetRoomId.trim().toUpperCase();
    socketRef.current?.emit("joinRoom", {
      roomId: normalizedRoomId,
      playerName: playerName.trim(),
      baseTime,
      increment,
      spectator: true,
    });
  }

  function sendChat() {
    if (!chatInput.trim() || !roomId) return;
    const payload = { roomId, author: playerName || 'Guest', message: chatInput.trim() };
    socketRef.current?.emit('chatMessage', payload);
    setChatInput("");
  }

  function handleCreateMatch() {
    if (!authToken) {
      setStatusMessage("Please log in first to create a match.");
      return;
    }
    if (!playerName.trim()) {
      setStatusMessage("Enter your player name before creating a match.");
      return;
    }

    const newRoomId = createRoomId();
    setJoinRoomId(newRoomId);
    handleJoinRoom(newRoomId);
    // optimistic refresh
    fetchRooms().catch(() => {});
  }

  function handleLeaveMatch() {
    if (!roomId) {
      return;
    }

    socketRef.current?.emit("leaveRoom", { roomId });
    setJoined(false);
    setRoomId("");
    setPlayerColor(null);
    setMatchStatus("waiting");
    setFen("start");
    setMoveHistory([]);
    setCurrentTurn("w");
    setWhiteName("White");
    setBlackName("Black");
    setWhiteTime(baseTime);
    setBlackTime(baseTime);
    setResultText(null);
    setStatusMessage("You left the match. Create or join another room.");
  }

  async function fetchRooms() {
    try {
      const res = await fetch(`${serverUrl}/rooms`);
      if (!res.ok) return;
      const data = await res.json();
      setRoomsList(data || []);
    } catch (e) {
      // ignore
    }
  }

  async function fetchPlayerHistory(token?: string) {
    const activeToken = token || authToken;
    if (!activeToken) {
      setPlayerHistory([]);
      return;
    }

    try {
      const res = await fetch(`${serverUrl}/player/history`, {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!res.ok) {
        setPlayerHistory([]);
        return;
      }
      const data = await res.json();
      setPlayerHistory(data || []);
    } catch (e) {
      setPlayerHistory([]);
    }
  }

  function parseSeedValues() {
    return seedValues.split("\n").reduce((acc: Record<string, number>, line) => {
      const [name, value] = line.split(":").map((part) => part.trim());
      if (name) {
        acc[name] = Number(value) || 0;
      }
      return acc;
    }, {});
  }

  async function handleLogin() {
    try {
      const res = await fetch(`${(import.meta.env.VITE_SERVER_URL as string) || "http://localhost:4000"}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Login failed");
      setAuthToken(data.token);
      setAuthUsername(data.username);
      setAuthRole(data.role);
      setPlayerName(data.username);
      localStorage.setItem("chessToken", data.token);
      localStorage.setItem("chessUsername", data.username);
      localStorage.setItem("chessRole", data.role);
      setStatusMessage(`Logged in as ${data.username}`);
      setLoginPassword("");
      await fetchPlayerHistory(data.token);
    } catch (error: any) {
      setStatusMessage(error.message || "Login failed");
    }
  }

  async function handleRegister() {
    try {
      const res = await fetch(`${(import.meta.env.VITE_SERVER_URL as string) || "http://localhost:4000"}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: registerUsername.trim(), password: registerPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Registration failed");
      setAuthToken(data.token);
      setAuthUsername(data.username);
      setAuthRole(data.role);
      setPlayerName(data.username);
      localStorage.setItem("chessToken", data.token);
      localStorage.setItem("chessUsername", data.username);
      localStorage.setItem("chessRole", data.role);
      setStatusMessage(`Registered and logged in as ${data.username}`);
      setRegisterPassword("");
      setRegisterUsername("");
      await fetchPlayerHistory(data.token);
    } catch (error: any) {
      setStatusMessage(error.message || "Registration failed");
    }
  }

  function handleLogout() {
    setAuthToken(null);
    setAuthUsername("");
    setAuthRole(null);
    setPlayerHistory([]);
    localStorage.removeItem("chessToken");
    localStorage.removeItem("chessUsername");
    localStorage.removeItem("chessRole");
    setStatusMessage("Logged out.");
  }

  function handleReconnectToLastRoom() {
    if (!socketRef.current) return;
    socketRef.current.emit("reconnectLastRoom");
  }

  async function loadAdminDashboard() {
    if (!authToken) {
      setStatusMessage("Admin login required.");
      return;
    }
    try {
      const res = await fetch(`${(import.meta.env.VITE_SERVER_URL as string) || "http://localhost:4000"}/organizer/dashboard`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load dashboard");
      setDashboardRooms(data.rooms || []);
      setDashboardResults(data.results || []);
      setStatusMessage("Loaded admin dashboard.");
    } catch (error: any) {
      setStatusMessage(error.message || "Failed to load dashboard");
    }
  }

  function handleTimeSelection(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = Number(event.target.value);
    setBaseTime(value);
  }

  function handleIncrementSelection(event: React.ChangeEvent<HTMLSelectElement>) {
    const value = Number(event.target.value);
    setIncrement(value);
  }

  function handleMove(sourceSquare: string, targetSquare: string) {
    if (!joined || matchStatus !== "playing" || !playerColor) {
      return false;
    }

    const colorTurn = currentTurn === "w" ? "white" : "black";
    if (colorTurn !== playerColor) {
      return false;
    }

    socketRef.current?.emit("makeMove", {
      roomId,
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    return false;
  }

  function copyRoomCode() {
    if (!roomId) return;
    try {
      navigator.clipboard.writeText(roomId);
      setStatusMessage("Room code copied to clipboard.");
    } catch {
      setStatusMessage("Unable to copy room code.");
    }
  }

  function downloadMoveHistory() {
    const lines = moveHistory.length > 0
      ? [
          `Room: ${roomId}`,
          `White: ${whiteName}`,
          `Black: ${blackName}`,
          "",
          "Move History",
          "White | Black",
          ...moveHistoryLines,
        ]
      : ["No moves yet"];

    const content = lines.join("\r\n");
    const blob = new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `move-history-${roomId || "match"}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function handleResign() {
    if (!roomId || !joined || !playerColor || !socketRef.current) {
      return;
    }
    socketRef.current.emit("resign", { roomId });
  }

  const isMyTurn = playerColor === "white" ? currentTurn === "w" : currentTurn === "b";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        minHeight: "100vh",
        backgroundColor: "#111111",
        color: "white",
        gap: "30px",
        padding: "30px",
      }}
    >
      <div style={{ flex: "0 0 760px", display: "flex", flexDirection: "column", gap: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              backgroundColor: connected ? "#34d399" : "#f97316",
            }}
          />
          <span>{connected ? "Server connected" : "Server disconnected"}</span>
        </div>

        <div
          style={{
            backgroundColor: "#1f2937",
            borderRadius: "16px",
            padding: "18px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          }}
        >
          {joined ? (
            <Chessboard
              position={fen}
              boardWidth={720}
              onPieceDrop={handleMove}
              customBoardStyle={{
                borderRadius: "15px",
                boxShadow: "0 20px 40px rgba(0, 0, 0, 0.35)",
              }}
              customLightSquareStyle={{ backgroundColor: "#f0d9b5" }}
              customDarkSquareStyle={{ backgroundColor: "#b58863" }}
              arePiecesDraggable={joined && matchStatus === "playing" && isMyTurn}
            />
          ) : (
            <div style={{ display: "grid", gap: "16px" }}>
              <h2 style={{ marginTop: 0, marginBottom: "0" }}>Ready to play</h2>
              <p style={{ color: "#cbd5e1", margin: 0 }}>
                Log in, create a match, or join an active room to start playing.
              </p>

            </div>
          )}
        </div>

        {!joined && (
          <div
            style={{
              backgroundColor: "#1f2937",
              borderRadius: "16px",
              padding: "18px",
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: "18px" }}>Match setup</h2>
            <div style={{ display: "grid", gap: "14px" }}>
              {!authToken ? (
                <div style={{ display: "grid", gap: "12px", padding: "14px", borderRadius: "14px", backgroundColor: "#111827" }}>
                  <div style={{ fontWeight: 600 }}>Login or register</div>
                  <div style={{ display: "grid", gap: "10px" }}>
                    <div style={{ display: "grid", gap: "8px" }}>
                      <label style={{ display: "grid", gap: "6px" }}>
                        Username
                        <input
                          value={loginUsername}
                          onChange={(event) => setLoginUsername(event.target.value)}
                          placeholder="Username"
                          style={{ width: "100%", padding: "10px", borderRadius: "10px", border: "1px solid #374151", backgroundColor: "#0f172a", color: "white" }}
                        />
                      </label>
                      <label style={{ display: "grid", gap: "6px" }}>
                        Password
                        <input
                          type="password"
                          value={loginPassword}
                          onChange={(event) => setLoginPassword(event.target.value)}
                          placeholder="Password"
                          style={{ width: "100%", padding: "10px", borderRadius: "10px", border: "1px solid #374151", backgroundColor: "#0f172a", color: "white" }}
                        />
                      </label>
                      <button onClick={handleLogin} style={{ width: "100%", padding: "12px", borderRadius: "10px", border: "none", backgroundColor: "#2563eb", color: "white", cursor: "pointer" }}>
                        Login
                      </button>
                    </div>
                    <div style={{ display: "grid", gap: "8px" }}>
                      <label style={{ display: "grid", gap: "6px" }}>
                        New account
                        <input
                          value={registerUsername}
                          onChange={(event) => setRegisterUsername(event.target.value)}
                          placeholder="Username"
                          style={{ width: "100%", padding: "10px", borderRadius: "10px", border: "1px solid #374151", backgroundColor: "#0f172a", color: "white" }}
                        />
                      </label>
                      <label style={{ display: "grid", gap: "6px" }}>
                        Password
                        <input
                          type="password"
                          value={registerPassword}
                          onChange={(event) => setRegisterPassword(event.target.value)}
                          placeholder="Password"
                          style={{ width: "100%", padding: "10px", borderRadius: "10px", border: "1px solid #374151", backgroundColor: "#0f172a", color: "white" }}
                        />
                      </label>
                      <button onClick={handleRegister} style={{ width: "100%", padding: "12px", borderRadius: "10px", border: "none", backgroundColor: "#10b981", color: "white", cursor: "pointer" }}>
                        Register
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {isPlayer ? (
                <div style={{ display: "grid", gap: "12px" }}>
                  <label style={{ display: "grid", gap: "8px" }}>
                    Your name
                    <input
                      value={authUsername || playerName}
                      onChange={(event) => setPlayerName(event.target.value)}
                      placeholder="Enter your name"
                      disabled={!!authToken && authRole === "player"}
                      style={{
                        width: "100%",
                        padding: "12px",
                        borderRadius: "10px",
                        border: "1px solid #374151",
                        backgroundColor: authToken && authRole === "player" ? "#1f2937" : "#111827",
                        color: "white",
                      }}
                    />
                  </label>

                  <label style={{ display: "grid", gap: "8px" }}>
                    Match ID
                    <input
                      value={joinRoomId}
                      onChange={(event) => setJoinRoomId(event.target.value)}
                      placeholder="Enter or create an ID"
                      style={{
                        width: "100%",
                        padding: "12px",
                        borderRadius: "10px",
                        border: "1px solid #374151",
                        backgroundColor: "#111827",
                        color: "white",
                      }}
                    />
                  </label>

                  <label style={{ display: "grid", gap: "8px" }}>
                    Starting time
                    <select
                      value={baseTime}
                      onChange={handleTimeSelection}
                      style={{
                        width: "100%",
                        padding: "12px",
                        borderRadius: "10px",
                        border: "1px solid #374151",
                        backgroundColor: "#111827",
                        color: "white",
                      }}
                    >
                      <option value={60}>1 min</option>
                      <option value={180}>3 min</option>
                      <option value={300}>5 min</option>
                      <option value={600}>10 min</option>
                    </select>
                  </label>

                  <label style={{ display: "grid", gap: "8px" }}>
                    Increment per move
                    <select
                      value={increment}
                      onChange={handleIncrementSelection}
                      style={{
                        width: "100%",
                        padding: "12px",
                        borderRadius: "10px",
                        border: "1px solid #374151",
                        backgroundColor: "#111827",
                        color: "white",
                      }}
                    >
                      <option value={0}>0 sec</option>
                      <option value={1}>1 sec</option>
                      <option value={2}>2 sec</option>
                      <option value={3}>3 sec</option>
                      <option value={5}>5 sec</option>
                    </select>
                  </label>

                  <div style={{ display: "flex", gap: "12px" }}>
                    <button
                      onClick={handleCreateMatch}
                      style={{
                        flex: 1,
                        padding: "14px",
                        borderRadius: "10px",
                        border: "none",
                        backgroundColor: "#2563eb",
                        cursor: "pointer",
                      }}
                    >
                      Create match
                    </button>
                    <button
                      onClick={() => handleJoinRoom(joinRoomId)}
                      style={{
                        flex: 1,
                        padding: "14px",
                        borderRadius: "10px",
                        border: "none",
                        backgroundColor: "#10b981",
                        cursor: "pointer",
                      }}
                    >
                      Join match
                    </button>
                  </div>
                </div>
              ) : !authToken ? (
                <div style={{ padding: "18px", borderRadius: "16px", backgroundColor: "#111827" }}>
                  <div style={{ color: "#cbd5e1" }}>Log in to create or join matches and view your past games.</div>
                </div>
              ) : (
                <div style={{ padding: "18px", borderRadius: "16px", backgroundColor: "#111827" }}>
                  <div style={{ color: "#cbd5e1" }}>Admin users manage tournaments here and do not join player matches.</div>
                </div>
              )}

              {authToken ? (
              <div style={{ marginTop: 6 }}>
                <strong style={{ display: "block", marginBottom: 8 }}>Active matches</strong>
                <div style={{ display: "grid", gap: 8 }}>
                  {roomsList.length === 0 ? (
                    <div style={{ color: "#9ca3af" }}>No active matches.</div>
                  ) : (
                    roomsList.map((r) => (
                      <div
                        key={r.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px",
                          borderRadius: "8px",
                          backgroundColor: "#0f172a",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600 }}>{r.id}</div>
                          <div style={{ color: "#9ca3af", fontSize: 12 }}>{r.status} • {r.whiteName || 'Waiting' } vs {r.blackName || 'Waiting'}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            onClick={() => { setJoinRoomId(r.id); handleJoinRoom(r.id); }}
                            style={{ padding: "8px 10px", borderRadius: 8, border: "none", backgroundColor: "#10b981", color: "white", cursor: "pointer" }}
                          >
                            Join
                          </button>
                          <button
                            onClick={() => handleJoinRoomAsSpectator(r.id)}
                            style={{ padding: "8px 10px", borderRadius: 8, border: "none", backgroundColor: "#6b7280", color: "white", cursor: "pointer" }}
                          >
                            Spectate
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => fetchRooms()} style={{ padding: "8px 10px", borderRadius: 8, border: "none", backgroundColor: "#2563eb", color: "white" }}>Refresh</button>
                </div>
              </div>
              ) : null}

              <div style={{ marginTop: "8px", color: "#cbd5e1", minHeight: "24px" }}>{statusMessage}</div>
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: "0 0 420px", display: "grid", gap: "24px" }}>
        <div
          style={{
            backgroundColor: "transparent",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "none",
          }}
        >
          
          {joined ? (
            <div style={{ display: "grid", gap: "12px" }}>
              <div style={{ display: "grid", gap: "12px", padding: "16px", borderRadius: "14px", backgroundColor: "transparent" }}>
                <div style={{ fontWeight: 600 }}>Players</div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>White</div>
                    <div>{whiteName || "Waiting"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>Black</div>
                    <div>{blackName || "Waiting"}</div>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gap: "12px" }}>
                <div style={{ padding: "12px", borderRadius: "14px", backgroundColor: "transparent" }}>
                  <div style={{ color: "#9ca3af", marginBottom: "6px" }}>Match status</div>
                  <div>{matchStatus === "waiting" ? "Waiting for opponent" : matchStatus === "playing" ? isMyTurn ? "Your turn" : "Opponent's turn" : `Finished: ${resultText || "Game over"}`}</div>
                </div>
                <div style={{ padding: "12px", borderRadius: "14px", backgroundColor: "transparent" }}>
                  <div style={{ color: "#9ca3af", marginBottom: "6px" }}>Increment</div>
                  <div>{increment} sec</div>
                </div>
                <div style={{ display: "flex", gap: "12px" }}>
                  <div style={{ flex: 1, padding: "12px", borderRadius: "14px", backgroundColor: "transparent" }}>
                    <div style={{ color: "#9ca3af", marginBottom: "6px" }}>White clock</div>
                    <div style={{ fontSize: "22px" }}>{formatTime(whiteTime)}</div>
                  </div>
                  <div style={{ flex: 1, padding: "12px", borderRadius: "14px", backgroundColor: "#111827" }}>
                    <div style={{ color: "#9ca3af", marginBottom: "6px" }}>Black clock</div>
                    <div style={{ fontSize: "22px" }}>{formatTime(blackTime)}</div>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: "12px" }}>
                {playerColor !== "spectator" && matchStatus === "playing" ? (
                  <button onClick={handleResign} style={{ flex: 1, padding: "14px", borderRadius: "12px", border: "none", backgroundColor: "#f97316", color: "white", cursor: "pointer" }}>
                    Resign
                  </button>
                ) : null}
                <button onClick={handleLeaveMatch} style={{ flex: 1, padding: "14px", borderRadius: "12px", border: "none", backgroundColor: "#ef4444", color: "white", cursor: "pointer" }}>
                  Leave match
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: "12px" }}>
              {authToken ? (
                <div style={{ padding: "14px", borderRadius: "14px", backgroundColor: "transparent" }}>
                  <button onClick={handleLogout} style={{ padding: "10px 12px", borderRadius: 8, border: "none", backgroundColor: "#ef4444", color: "white", cursor: "pointer" }}>Logout</button>
                </div>
              ) : (
                <div style={{ padding: "14px", borderRadius: "14px", backgroundColor: "transparent", color: "#cbd5e1" }}>Not logged in</div>
              )}
            </div>
          )}
        </div>

        {joined ? (
          <div
            style={{
              backgroundColor: "transparent",
              borderRadius: "16px",
              padding: "24px",
              boxShadow: "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
              <h2 style={{ margin: 0 }}>Move history</h2>
              <button onClick={downloadMoveHistory} style={{ padding: "10px 14px", borderRadius: "12px", border: "none", backgroundColor: "#2563eb", color: "white", cursor: "pointer" }}>
                Download
              </button>
            </div>
            <div style={{ display: "grid", gap: "10px", maxHeight: "460px", overflow: "auto" }}>
              {moveHistoryLines.length === 0 ? (
                <div style={{ color: "#9ca3af" }}>No moves have been played yet.</div>
              ) : (
                moveHistoryLines.map((line, idx) => (
                  <div key={idx} style={{ padding: "12px", borderRadius: "12px", backgroundColor: "transparent", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default App;
