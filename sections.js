'use strict';

// "Methods" in a .sql file: blocks between `-- #region <name>` and `-- #endregion`
// (the same markers VS Code's built-in SQL folding uses). Regions may nest; an unclosed
// region runs to the end of the file.

const START = /^\s*--\s*#region\b[ \t]*(.*)$/;
const END = /^\s*--\s*#endregion\b/;
// Group header: a name between runs of `=`, e.g. `-- ========== Inbound ==========`.
const GROUP = /^\s*--\s*={3,}\s*([^=\s].*?)\s*={3,}\s*$/;

/**
 * @param {string} text
 * @returns {{name: string, headerLine: number, endLine: number}[]} sorted by headerLine;
 *   endLine is the #endregion line (or the line count when unclosed). The body is the lines in between.
 */
function findSections(text) {
    const lines = text.split(/\r?\n/);
    const sections = [];
    const open = [];
    lines.forEach((line, i) => {
        const start = START.exec(line);
        if (start) {
            open.push({ name: start[1].trim() || `บรรทัด ${i + 1}`, headerLine: i });
        } else if (END.test(line) && open.length > 0) {
            sections.push({ ...open.pop(), endLine: i });
        }
    });
    for (const section of open) {
        sections.push({ ...section, endLine: lines.length });
    }
    return sections.sort((a, b) => a.headerLine - b.headerLine);
}

/**
 * Regions filed under the nearest group header above them.
 * @param {string} text
 * @returns {{ungrouped: object[], groups: {name: string, line: number, sections: object[]}[]}}
 *   ungrouped: regions before the first header; groups in file order, each with its findSections() entries.
 */
function groupSections(text) {
    const groups = [];
    text.split(/\r?\n/).forEach((line, i) => {
        const group = GROUP.exec(line);
        if (group) {
            groups.push({ name: group[1], line: i, sections: [] });
        }
    });
    const ungrouped = [];
    for (const section of findSections(text)) {
        const owner = groups.filter(g => g.line < section.headerLine).pop();
        (owner ? owner.sections : ungrouped).push(section);
    }
    return { ungrouped, groups };
}

module.exports = { findSections, groupSections };
