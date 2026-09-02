const fs = require('fs');

function cleanInlineStyles(file) {
    let content = fs.readFileSync(file, 'utf-8');
    // Remove font-size inline styles like font-size: 13px;
    content = content.replace(/font-size:\s*\d+px;?/g, '');
    content = content.replace(/font-size:\s*[\d.]+em;?/g, '');
    content = content.replace(/font-size:\s*[\d.]+rem;?/g, '');
    
    // clean up empty style attributes
    content = content.replace(/style="\s*"/g, '');
    fs.writeFileSync(file, content, 'utf-8');
}

cleanInlineStyles('index.html');
cleanInlineStyles('app.js');

let css = fs.readFileSync('styles.css', 'utf-8');

// Completely rebuild the typography base
// Remove ALL font-size declarations outside @media print
const printIndex = css.indexOf('@media print');
let cssBefore = css.substring(0, printIndex);
const cssAfter = css.substring(printIndex);

// Strip all font-sizes from screen CSS
cssBefore = cssBefore.replace(/^\s*font-size:\s*\d+px\s*!?i?m?p?o?r?t?a?n?t?;\n?/gm, '');

// Re-inject standard hierarchy at the top
cssBefore = cssBefore.replace(/body\s*\{([^}]*)\}/, (match, p1) => {
    return `body {${p1.replace(/font-size.*?;/g, '')}  font-size: 14px;\n  line-height: 1.5;\n}`;
});

// Update headers and base typography properly
const typographyBase = `
/* Typography Base */
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 0; }
h1 { font-size: 24px; margin-bottom: 16px; color: var(--teal); }
h2 { font-size: 18px; margin-bottom: 16px; }
h3 { font-size: 15px; margin-bottom: 12px; }

.formSubtitle { font-size: 13px; font-weight: 700; text-transform: uppercase; color: var(--teal); }
.note, .guideLine, label { font-size: 13px; color: var(--muted); }
.brand strong { font-size: 18px; font-weight: 700; display: block; }
.brand span { font-size: 12px; color: var(--muted); }
.metrics strong { font-size: 32px; font-weight: 700; color: var(--teal); }

table th { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); padding: 12px 16px !important; }
table td { font-size: 14px; padding: 12px 16px !important; }

button { font-size: 14px; font-weight: 500; }
input, select, textarea { font-size: 14px; padding: 10px 12px; }
.search { padding: 12px 16px; font-size: 14px; }
.reportHeader h3 { font-size: 18px; color: var(--teal); }
.reportHeader p { font-size: 13px; color: var(--muted); margin: 2px 0; }
`;

// Append typography base right after root
cssBefore = cssBefore.replace(/\* \{ box-sizing: border-box; \}/, `* { box-sizing: border-box; }\n${typographyBase}`);

// Modernize table looks
cssBefore = cssBefore.replace(/table \{\s*width: 100%;\s*border-collapse: collapse;\s*\}/, `table { width: 100%; border-collapse: separate; border-spacing: 0; }`);
cssBefore = cssBefore.replace(/border-bottom: 1px solid var\(--line\);/g, `border-bottom: 1px solid var(--line);`);

// Give panels more breathing room and better shadows
cssBefore = cssBefore.replace(/\.panel \{([^}]*)\}/, (match, p1) => {
    return match.replace(/padding:\s*\d+px;/, 'padding: 24px;');
});
cssBefore = cssBefore.replace(/box-shadow: 0 4px 12px rgba\(0,0,0,\.05\);/g, 'box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);');
cssBefore = cssBefore.replace(/border-radius:\s*8px;/g, 'border-radius: 12px;');

css = cssBefore + cssAfter;

fs.writeFileSync('styles.css', css, 'utf-8');
console.log('Files cleaned and updated.');
