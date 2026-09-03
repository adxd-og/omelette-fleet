#!/usr/bin/env node
// omelette-fleet :: servers/gemini.mjs — MCP stdio entrypoint for the Gemini (agy) unit.
// Register with:  claude mcp add -s user <prefix>-gemini -- node /abs/path/servers/gemini.mjs
import { startUnit } from '../core/unit.mjs';
import unit from '../units/gemini/adapter.mjs';

startUnit(unit);
