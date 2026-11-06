#!/usr/bin/env node
// omelette-fleet :: servers/mistral.mjs — MCP stdio entrypoint for the Mistral unit.
// Register with:  claude mcp add -s user <prefix>-mistral -- node /abs/path/servers/mistral.mjs
import { startUnit } from '../core/unit.mjs';
import unit from '../units/mistral/adapter.mjs';

startUnit(unit);
