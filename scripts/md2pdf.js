// Usage: node scripts/md2pdf.js file1.md [file2.md ...]  -> writes file.pdf next to each .md
const { execFileSync } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const css = path.join(__dirname, 'pdf-style.css');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const md of process.argv.slice(2)) {
    const html = execFileSync('pandoc', [md, '-f', 'gfm', '-t', 'html5', '--standalone',
      '--metadata', 'title=' + path.basename(md, '.md'), '--css', css, '--embed-resources',
      '-V', 'title-prefix=', '--template', path.join(__dirname, 'pdf-template.html')]).toString();
    await page.setContent(html, { waitUntil: 'load' });
    const out = md.replace(/\.md$/, '.pdf');
    await page.pdf({ path: out, format: 'A4', printBackground: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888">My Amazon Shop · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
    console.log('wrote', out);
  }
  await browser.close();
})();
