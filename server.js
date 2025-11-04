const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

const WINNING_LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
];

const games = new Map();
const clients = new Map();
let clientCounter = 1;

const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
    }

    const urlPath = req.url.split('?')[0];

    if (urlPath === '/' || urlPath === '' || urlPath === '/index.html' || urlPath === '/tictactoe.html') {
        return serveHtml(res);
    }

    if (urlPath === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
    const clientId = `c-${clientCounter++}`;
    clients.set(clientId, { ws, gameId: null, symbol: null });

    ws.on('message', (rawMessage) => {
        let payload;
        try {
            payload = JSON.parse(rawMessage.toString());
        } catch (error) {
            sendError(ws, 'Invalid message format.');
            return;
        }

        if (!payload || typeof payload !== 'object') {
            sendError(ws, 'Invalid message payload.');
            return;
        }

        switch (payload.type) {
            case 'join':
                handleJoin(ws, clientId, payload);
                break;
            case 'move':
                handleMove(ws, clientId, payload);
                break;
            case 'reset':
                handleReset(ws, clientId);
                break;
            default:
                sendError(ws, `Unknown message type: ${payload.type}`);
        }
    });

    ws.on('close', () => {
        handleDisconnect(clientId);
        clients.delete(clientId);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error.message);
    });
});

server.listen(PORT, () => {
    console.log(`Tic-Tac-Toe server listening on http://localhost:${PORT}`);
});

function serveHtml(res) {
    const filePath = path.join(__dirname, 'tictactoe.html');
    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Failed to load game.');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(content);
    });
}

function handleJoin(ws, clientId, payload) {
    const clientMeta = clients.get(clientId);
    if (!clientMeta) {
        sendError(ws, 'Client not registered.');
        return;
    }

    const rawGameId = typeof payload.gameId === 'string' ? payload.gameId : '';
    const rawName = typeof payload.name === 'string' ? payload.name : '';

    const gameId = sanitizeGameId(rawGameId);
    const name = sanitizeName(rawName);

    if (!gameId) {
        sendError(ws, 'A valid Game ID is required.');
        return;
    }

    if (!name) {
        sendError(ws, 'A valid name is required.');
        return;
    }

    let game = games.get(gameId);
    if (!game) {
        game = createGame(gameId);
        games.set(gameId, game);
    }

    let assignedSymbol = null;
    let message;

    const reconnectionCandidate = game.players.find(player =>
        !player.connected && player.name && player.name.toLowerCase() === name.toLowerCase()
    );

    if (reconnectionCandidate) {
        reconnectionCandidate.connected = true;
        reconnectionCandidate.clientId = clientId;
        reconnectionCandidate.name = name;
        assignedSymbol = reconnectionCandidate.symbol;
        message = `Reconnected as Player ${assignedSymbol}.`;
    } else {
        const vacantSlot = game.players.find(player => !player.connected);
        if (vacantSlot) {
            vacantSlot.connected = true;
            vacantSlot.clientId = clientId;
            vacantSlot.name = name;
            assignedSymbol = vacantSlot.symbol;
            message = `Connected to game ${gameId} as Player ${assignedSymbol}. Share this Game ID with a friend to play.`;
        } else if (game.players.length < 2) {
            const availableSymbol = ['X', 'O'].find(symbol => !game.players.some(player => player.symbol === symbol));
            const symbolToUse = availableSymbol || (game.players.length === 0 ? 'X' : 'O');
            game.players.push({
                clientId,
                name,
                symbol: symbolToUse,
                connected: true
            });
            assignedSymbol = symbolToUse;
            message = `Connected to game ${gameId} as Player ${assignedSymbol}. Share this Game ID with a friend to play.`;
        } else {
            assignedSymbol = null;
            message = 'Connected as spectator. Two players are already in the game.';
        }
    }

    clientMeta.gameId = gameId;
    clientMeta.symbol = assignedSymbol;

    syncGameStatus(game);

    send(ws, {
        type: 'joined',
        playerId: clientId,
        symbol: assignedSymbol,
        gameId,
        message,
        game: serializeGame(game)
    });

    broadcastGameState(gameId);
}

function handleMove(ws, clientId, payload) {
    const clientMeta = clients.get(clientId);
    if (!clientMeta || !clientMeta.gameId || !clientMeta.symbol) {
        sendError(ws, 'You must join a game as a player before making moves.');
        return;
    }

    const game = games.get(clientMeta.gameId);
    if (!game) {
        sendError(ws, 'Game session not found.');
        return;
    }

    if (game.status !== 'playing') {
        sendError(ws, 'The game is not currently active.');
        return;
    }

    if (clientMeta.symbol !== game.currentPlayer) {
        sendError(ws, "It's not your turn yet.");
        return;
    }

    const index = Number.isInteger(payload.index) ? payload.index : NaN;
    if (!Number.isInteger(index) || index < 0 || index > 8) {
        sendError(ws, 'Invalid move index.');
        return;
    }

    if (game.board[index] !== '') {
        sendError(ws, 'This cell is already taken.');
        return;
    }

    game.board[index] = clientMeta.symbol;

    const winningLine = WINNING_LINES.find(line => line.every(pos => game.board[pos] === clientMeta.symbol));
    const isDraw = game.board.every(cell => cell !== '');

    if (winningLine) {
        game.status = 'finished';
        game.winner = clientMeta.symbol;
        game.result = 'win';
        game.winningCombination = winningLine;
    } else if (isDraw) {
        game.status = 'finished';
        game.winner = null;
        game.result = 'draw';
        game.winningCombination = [];
    } else {
        game.currentPlayer = clientMeta.symbol === 'X' ? 'O' : 'X';
    }

    broadcastGameState(game.id);
}

function handleReset(ws, clientId) {
    const clientMeta = clients.get(clientId);
    if (!clientMeta || !clientMeta.gameId || !clientMeta.symbol) {
        sendError(ws, 'Only active players can reset the game.');
        return;
    }

    const game = games.get(clientMeta.gameId);
    if (!game) {
        sendError(ws, 'Game session not found.');
        return;
    }

    const connectedPlayers = game.players.filter(player => player.connected);
    if (connectedPlayers.length < 2) {
        sendError(ws, 'Both players must be connected to start a new round.');
        return;
    }

    game.board = Array(9).fill('');
    game.currentPlayer = 'X';
    game.status = 'playing';
    game.winner = null;
    game.result = null;
    game.winningCombination = [];

    broadcastGameState(game.id);
}

function handleDisconnect(clientId) {
    const clientMeta = clients.get(clientId);
    if (!clientMeta || !clientMeta.gameId) {
        return;
    }

    const game = games.get(clientMeta.gameId);
    if (!game) {
        return;
    }

    const player = game.players.find(entry => entry.clientId === clientId);
    if (player) {
        player.connected = false;
        player.clientId = null;
    }

    syncGameStatus(game);
    broadcastGameState(game.id);
    cleanupGame(game.id);
}

function createGame(gameId) {
    return {
        id: gameId,
        board: Array(9).fill(''),
        currentPlayer: 'X',
        status: 'waiting',
        winner: null,
        result: null,
        winningCombination: [],
        players: []
    };
}

function sanitizeGameId(id) {
    return id
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function sanitizeName(name) {
    return name
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 30);
}

function serializeGame(game) {
    return {
        id: game.id,
        board: [...game.board],
        currentPlayer: game.currentPlayer,
        status: game.status,
        winner: game.winner,
        result: game.result,
        winningCombination: [...game.winningCombination],
        players: game.players.map(player => ({
            name: player.name,
            symbol: player.symbol,
            connected: player.connected
        }))
    };
}

function broadcastGameState(gameId) {
    const game = games.get(gameId);
    if (!game) {
        return;
    }

    const message = JSON.stringify({
        type: 'state',
        game: serializeGame(game)
    });

    for (const [id, client] of clients.entries()) {
        if (client.gameId === gameId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
        }
    }
}

function syncGameStatus(game) {
    if (!game || game.status === 'finished') {
        return;
    }

    const connectedPlayers = game.players.filter(player => player.connected);
    if (connectedPlayers.length >= 2) {
        if (game.status === 'waiting') {
            game.status = 'playing';
        }
        if (!['X', 'O'].includes(game.currentPlayer)) {
            game.currentPlayer = 'X';
        }
    } else {
        game.status = 'waiting';
    }
}

function cleanupGame(gameId) {
    const game = games.get(gameId);
    if (!game) {
        return;
    }

    const hasActiveConnections = [...clients.values()].some(client => client.gameId === gameId);
    if (!hasActiveConnections) {
        games.delete(gameId);
    }
}

function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function sendError(ws, message) {
    send(ws, { type: 'error', message });
}

process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    server.close(() => process.exit(0));
});
