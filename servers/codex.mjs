#!/usr/bin/env node
// omelette-fleet :: servers/codex.mjs — MCP stdio entrypoint for the Codex unit.
// Register with:  claude mcp add -s user <prefix>-codex -- node /abs/path/servers/codex.mjs
import { startUnit } from '../core/unit.mjs';
import unit from '../units/codex/adapter.mjs';

startUnit(unit);
