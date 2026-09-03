#!/usr/bin/env node
// omelette-fleet :: servers/grok.mjs — MCP stdio entrypoint for the Grok unit.
// Register with:  claude mcp add -s user <prefix>-grok -- node /abs/path/servers/grok.mjs
import { startUnit } from '../core/unit.mjs';
import unit from '../units/grok/adapter.mjs';

startUnit(unit);
