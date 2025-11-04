# Tic-Tac-Toe Multiplayer

This project is a browser-based Tic-Tac-Toe game with realtime multiplayer support. Two players can join the same Game ID from different browsers and play against each other while observers can watch the match live.

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the WebSocket server:
   ```bash
   npm start
   ```
3. Open your browser to [http://localhost:3000](http://localhost:3000). Share the URL (which includes the Game ID) with a friend so they can join the same match.

## How It Works

- Enter a Game ID and your name, then click **Join Game**. Creating a new Game ID automatically starts a lobby and assigns you the `X` player.
- When a second player joins using the same Game ID, the match begins immediately and turns alternate between `X` and `O`.
- Additional connections beyond the two players join as spectators and receive live board updates.
- Either active player can trigger **New Game** once both players are connected to reset the board for another round.

## Project Structure

- `tictactoe.html` – Front-end UI and WebSocket client logic.
- `server.js` – Node.js WebSocket server that keeps game state in sync across clients.
- `package.json` – Project metadata and dependencies.