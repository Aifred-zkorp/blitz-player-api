# Blitz Player History API

Aggregated player stats across all Blitz S0 game slots on Starknet.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /player/:address` | Full player history (games, MMR, ranks, win/loss) |
| `GET /leaderboard/:slot` | Top 50 players for a specific slot |
| `GET /slots` | List all known slots and their status |
| `GET /health` | Health check |

## Example

```bash
curl https://blitz-player-api.up.railway.app/player/0x0643bce119f53a1ec83f57c4c42f694659c2da543d6f8a85b335d3f4bef12548
```

## Data Sources

Queries Torii indexer across 8+ active Blitz game slots (s0-game-5 through s0-game-12) plus historical slots.

## Stats Returned

- Games played (per slot + total)
- Win/loss record + win rate
- MMR history across all slots
- Best rank achieved
- Current active games
- Points per game

## Deploy

```bash
docker build -t blitz-api .
docker run -p 3000:3000 blitz-api
```

Or deploy to Railway/Render/Fly.io — works out of the box.
