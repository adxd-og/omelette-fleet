/**
 * omelette-fleet :: core/catalog.mjs
 * A unit's model catalog: the allowlist of `model` ids that may ever reach a
 * spawn, the optional `effort` allowlist, and the "which model for what"
 * cheat-sheet that goes into tool descriptions. Vendor CLIs fall back to a
 * default SILENTLY on an unknown --model, so the allowlist is a correctness
 * gate, not a convenience.
 *
 * Adapters build one from their own models file:
 *   makeCatalog({ models: GEMINI_MODELS, guide: GUIDE })
 * so a catalog synced from elsewhere (units/gemini/models.js is a verbatim
 * copy of ORION's source of truth) stays byte-identical to its origin.
 */

/**
 * @param {{models:{id:string,label?:string,family?:string,effort?:string,tier?:string,useFor?:string,avoid?:string}[],
 *          efforts?:string[], guide?:string, title?:string, vendorDefaultNote?:string}} o
 */
export function makeCatalog({ models, efforts = [], guide = '', title = 'MODEL CATALOG', vendorDefaultNote = 'omit `model` for the vendor default' }) {
  if (!Array.isArray(models) || !models.length) throw new Error('makeCatalog: models must be a non-empty array');
  for (const m of models) if (!m || typeof m.id !== 'string' || !m.id) throw new Error('makeCatalog: every model needs a string id');
  const ids = models.map((m) => m.id);
  return {
    models,
    efforts,
    guide,
    ids,
    isAllowedModel: (id) => typeof id === 'string' && ids.includes(id),
    modelEnum: () => ids.slice(),
    isAllowedEffort: (e) => typeof e === 'string' && efforts.includes(e),
    effortEnum: () => efforts.slice(),
    find: (id) => models.find((m) => m.id === id) || null,
    /** Human-readable dump for the `<unit>_models` tool. */
    render() {
      const lines = [`${title} (pass any \`id\` below as the \`model\` arg; ${vendorDefaultNote}):`, ''];
      for (const m of models) {
        const tags = [m.family, m.effort ? `${m.effort} effort` : null, m.tier].filter(Boolean).join(' · ');
        lines.push(`• ${m.id}${tags ? `  [${tags}]` : ''}`);
        if (m.useFor) lines.push(`    USE FOR: ${m.useFor}`);
        if (m.avoid) lines.push(`    AVOID:   ${m.avoid}`);
        lines.push('');
      }
      if (efforts.length) { lines.push(`EFFORT LEVELS (the \`effort\` arg): ${efforts.join(' | ')}`); lines.push(''); }
      if (guide) lines.push('GUIDE: ' + guide);
      return lines.join('\n');
    },
  };
}
