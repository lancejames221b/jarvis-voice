---
topic: Continuous Learning Mono-Repo — openjarvis + haivemind + dreaming + Claude Code sessions
generated_by: opusplan (claude -p --model opus)
generated_at: 2026-05-20T09:00:00-04:00
---

# Continuous Learning Mono-Repo: Jarvis + hAIveMind + Dreaming + Claude Code

## Goal
Every Claude Code session, opencode session, and Jarvis voice session feeds into and reads from a unified learning pipeline in a single GitHub mono-repo (`lancejames221b/openjarvis`), with proactive memory surfacing on session start and voice join.

## Prerequisites

| Prerequisite | Verification Command |
|--------------|---------------------|
| Git access to `lancejames221b/openjarvis` | `git -C /home/yari/Dev/openjarvis remote -v` |
| SSH to generic working | `ssh generic "echo ok"` |
| mcporter available on generic | `ssh generic "which mcporter && mcporter list"` |
| 1Password CLI authenticated | `op whoami` |
| haivemind MCP responding | `ssh generic "mcporter call haivemind.get_agent_roster"` |
| dreaming venv exists | `ssh generic "ls ~/.venvs/dreaming/bin/python"` |
| Obsidian vault accessible | `ssh generic "ls /media/generic/storage1/Obsidian/Claude/"` |
| Node.js 20+ on gamez | `node --version` |
| Python 3.11+ on generic | `ssh generic "python3 --version"` |

## Phases

### Phase 1: Create Trello Board (Day 1, ~30 min)

**Objective**: Set up project tracking board with all backlog items.

**Steps**:
1. Fetch Trello credentials:
   ```bash
   TRELLO_KEY=$(op read "op://Claude/Trello API/api_key")
   TRELLO_TOKEN=$(op read "op://Claude/Trello API/token")
   ```

2. Create board in Unit 221B workspace:
   ```bash
   curl -X POST "https://api.trello.com/1/boards" \
     -d "name=OpenJarvis Continuous Learning Mono-Repo" \
     -d "idOrganization=688bb869c60d976330203a3f" \
     -d "defaultLists=false" \
     -d "key=${TRELLO_KEY}" \
     -d "token=${TRELLO_TOKEN}" | jq -r '.id' > /tmp/board_id.txt
   ```

3. Create lists (order matters):
   ```bash
   BOARD_ID=$(cat /tmp/board_id.txt)
   for list in "Nice-to-Have" "Done" "In Review" "In Progress" "Backlog"; do
     curl -X POST "https://api.trello.com/1/lists" \
       -d "name=${list}" \
       -d "idBoard=${BOARD_ID}" \
       -d "pos=top" \
       -d "key=${TRELLO_KEY}" \
       -d "token=${TRELLO_TOKEN}"
   done
   ```

4. Get Backlog list ID:
   ```bash
   BACKLOG_ID=$(curl -s "https://api.trello.com/1/boards/${BOARD_ID}/lists?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}" | jq -r '.[] | select(.name=="Backlog") | .id')
   NICE_ID=$(curl -s "https://api.trello.com/1/boards/${BOARD_ID}/lists?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}" | jq -r '.[] | select(.name=="Nice-to-Have") | .id')
   ```

5. Create Backlog cards:
   ```bash
   CARDS=(
     "Mono-repo restructure: move dreaming/ into openjarvis/packages/dreaming"
     "Mono-repo restructure: move haivemind/ into openjarvis/packages/haivemind (replace submodule)"
     "Jarvis session-manager: proactive memory surface on voice join (top-3 relevant memories)"
     "Claude Code session start hook: inject top-10 haivemind memories into MEMORY.md"
     "dream-st integration: move cron/hook trigger into openjarvis/scripts/ as first-class"
     "dream-lt integration: move weekly cron into openjarvis systemd or package scripts"
     "Unified deploy script: one rsync/deploy from gamez dev to generic live for all packages"
     "haivemind rename from owner221b: fork + move to lancejames221b/agent-hivemind"
     "openjarvis package rename: jarvis-voice → openjarvis in package.json"
     "Cross-session learning: opencode sessions write to haivemind via mcporter on session end"
     "Jarvis learns from Claude Code: gateway can query haivemind for task-relevant memories mid-session"
   )
   for card in "${CARDS[@]}"; do
     curl -X POST "https://api.trello.com/1/cards" \
       -d "name=${card}" \
       -d "idList=${BACKLOG_ID}" \
       -d "key=${TRELLO_KEY}" \
       -d "token=${TRELLO_TOKEN}"
   done
   ```

6. Create Nice-to-Have cards:
   ```bash
   NICE_CARDS=(
     "qdrant HTTP API exposed as MCP tool for Claude Code semantic search"
     "Automated conflict detection: dreaming surfaces contradictions to Lance via Discord #hud"
     "Learning dashboard: /dream-status shows live stats in Discord embed"
   )
   for card in "${NICE_CARDS[@]}"; do
     curl -X POST "https://api.trello.com/1/cards" \
       -d "name=${card}" \
       -d "idList=${NICE_ID}" \
       -d "key=${TRELLO_KEY}" \
       -d "token=${TRELLO_TOKEN}"
   done
   ```

**Verification**:
```bash
curl -s "https://api.trello.com/1/boards/${BOARD_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}" | jq 'length'
# Expected: 14 cards
