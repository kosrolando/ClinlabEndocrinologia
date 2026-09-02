const fs = require('fs');

let css = fs.readFileSync('styles.css', 'utf-8');

// 1. Update :root
const rootPattern = /:root\s*\{[^}]*\}/;
const newRoot = `:root {
  color-scheme: light;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  --ink: #1e293b;
  --muted: #64748b;
  --line: #e2e8f0;
  --panel: #ffffff;
  --bg: #f8fafc;
  --teal: #0f766e;
  --teal-2: #ccfbf1;
  --gold: #10b981;
  --red: #ef4444;
}`;
css = css.replace(rootPattern, newRoot);

// 2. Add base font-size to body
css = css.replace(/body\s*\{([^}]*)\}/, (match, p1) => {
    if (!p1.includes('font-size:')) {
        return `body {${p1}  font-size: 14px;\n  line-height: 1.5;\n}`;
    }
    return match;
});

// 3. Update headers and specific texts
css = css.replace(/h1\s*\{\s*font-size:\s*\d+px;\s*\}/g, 'h1 { font-size: 24px; font-weight: 600; margin-bottom: 16px; }');
css = css.replace(/h2\s*\{\s*font-size:\s*\d+px;\s*\}/g, 'h2 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }');
css = css.replace(/\.brand strong\s*\{\s*display:\s*block;\s*font-size:\s*\d+px;\s*\}/g, '.brand strong { display: block; font-size: 18px; font-weight: 600; }');
css = css.replace(/\.brand span\s*\{\s*color:\s*var\(--muted\);\s*font-size:\s*\d+px;\s*\}/g, '.brand span { color: var(--muted); font-size: 12px; }');

// 4. Remove all smaller/arbitrary font sizes (10px, 11px, 12px, 13px) from screen rules (before @media print)
const printIndex = css.indexOf('@media print');
if (printIndex !== -1) {
    let cssBefore = css.substring(0, printIndex);
    const cssAfter = css.substring(printIndex);
    
    // Regex to match "font-size: XXpx;" where XX is 10, 11, 12, 13
    cssBefore = cssBefore.replace(/^\s*font-size:\s*1[0123]px\s*!?i?m?p?o?r?t?a?n?t?;\n?/gm, '');
    
    // Add some nice padding and shadows
    cssBefore = cssBefore.replace(/box-shadow: 0 4px 12px rgba\(0,0,0,\.05\);/g, 'box-shadow: 0 10px 25px -5px rgba(0,0,0,.05), 0 8px 10px -6px rgba(0,0,0,.01);');
    
    css = cssBefore + cssAfter;
}

fs.writeFileSync('styles.css', css, 'utf-8');
console.log('styles.css updated successfully.');
