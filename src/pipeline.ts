import { PlaywrightCrawler } from 'crawlee';
import axe from 'axe-core';
import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT_DIR, 'raw');

interface AxeResult {
  violations: any[];
  passes: any[];
  incomplete: any[];
  inapplicable: any[];
}

export async function runPipeline(url: string): Promise<{ autoBefore: number; autoAfter: number }> {
  console.log(`🚀 Starting accessibility pipeline for: ${url}`);

  // Step 1: Scrape the original site
  console.log('📥 Step 1: Scraping original site...');
  await scrapeWebsite(url);

  // Step 2: Run accessibility audit on original
  console.log('🔍 Step 2: Running initial accessibility audit...');
  const beforeScore = await runAxeAudit(RAW_DIR);

  // Step 3: Generate enhanced site using v0.dev
  console.log('🛠️  Step 3: Generating enhanced site with v0.dev...');
  await generateEnhancedSite();

  // Step 4: Run accessibility audit on enhanced site
  console.log('✅ Step 4: Running final accessibility audit...');
  const afterScore = await runAxeAuditOnEnhanced();

  return {
    autoBefore: beforeScore,
    autoAfter: afterScore
  };
}

async function scrapeWebsite(url: string): Promise<void> {
  const crawler = new PlaywrightCrawler({
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    },
    requestHandler: async ({ page, request, enqueueLinks }) => {
      console.log(`Processing ${request.loadedUrl}...`);

      // Wait for network idle
      await page.waitForLoadState('networkidle');

      // 1. Dump outerHTML → raw/noah.html
      const html = await page.locator('html').innerHTML();
      await fs.writeFile(path.join(RAW_DIR, 'noah.html'), `<!DOCTYPE html><html>${html}</html>`);

      // 2. Extract all visible text → raw/noah-text.json
      const textContent = await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;

              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden') {
                return NodeFilter.FILTER_REJECT;
              }

              return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
          }
        );

        const texts: string[] = [];
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent?.trim();
          if (text && text.length > 2) {
            texts.push(text);
          }
        }
        return texts;
      });

      await fs.writeFile(
        path.join(RAW_DIR, 'noah-text.json'),
        JSON.stringify({ texts: textContent }, null, 2)
      );

      // 3. Download all images → raw/images/
      const images = await page.locator('img').all();
      await fs.mkdir(path.join(RAW_DIR, 'images'), { recursive: true });

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const src = await img.getAttribute('src');
        if (src) {
          try {
            const imgUrl = new URL(src, request.loadedUrl).href;
            const response = await page.request.get(imgUrl);
            if (response.ok()) {
              const buffer = await response.body();
              const filename = `image_${i}_${path.basename(src).split('?')[0]}`;
              await fs.writeFile(path.join(RAW_DIR, 'images', filename), buffer);
            }
          } catch (error) {
            console.warn(`Failed to download image: ${src}`, error);
          }
        }
      }

      // 4. Download all CSS → raw/css/
      const cssLinks = await page.locator('link[rel="stylesheet"]').all();
      await fs.mkdir(path.join(RAW_DIR, 'css'), { recursive: true });

      for (let i = 0; i < cssLinks.length; i++) {
        const link = cssLinks[i];
        const href = await link.getAttribute('href');
        if (href) {
          try {
            const cssUrl = new URL(href, request.loadedUrl).href;
            const response = await page.request.get(cssUrl);
            if (response.ok()) {
              const cssContent = await response.text();
              const filename = `style_${i}_${path.basename(href).split('?')[0]}`;
              await fs.writeFile(path.join(RAW_DIR, 'css', filename), cssContent);
            }
          } catch (error) {
            console.warn(`Failed to download CSS: ${href}`, error);
          }
        }
      }

      // 5. Extract computed color palette → raw/palette.json
      const palette = await page.evaluate(() => {
        const colors = new Set<string>();
        const elements = document.querySelectorAll('*');

        elements.forEach(el => {
          const styles = window.getComputedStyle(el);
          [styles.color, styles.backgroundColor, styles.borderColor].forEach(color => {
            if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
              colors.add(color);
            }
          });
        });

        return Array.from(colors);
      });

      await fs.writeFile(
        path.join(RAW_DIR, 'palette.json'),
        JSON.stringify({ colors: palette }, null, 2)
      );

      // 6. Full-page screenshot → raw/noah.png
      await page.screenshot({
        path: path.join(RAW_DIR, 'noah.png'),
        fullPage: true
      });

      console.log(`✅ Scraped ${url} successfully`);
    },
  });

  await crawler.run([url]);
}

async function runAxeAudit(staticDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.url === '/') {
        const html = await fs.readFile(path.join(staticDir, 'noah.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start server'));
        return;
      }

      const testUrl = `http://localhost:${address.port}`;

      const { PlaywrightCrawler } = await import('crawlee');
      const crawler = new PlaywrightCrawler({
        headless: true,
        requestHandler: async ({ page }) => {
          // Inject axe-core
          await page.addScriptTag({ path: require.resolve('axe-core') });

          // Run axe audit
          const results: AxeResult = await page.evaluate(() => {
            return new Promise((resolve) => {
              (window as any).axe.run((err: any, results: AxeResult) => {
                if (err) throw err;
                resolve(results);
              });
            });
          });

          const score = Math.max(0, 100 - results.violations.length);
          console.log(`🔍 Original site accessibility score: ${score}% (${results.violations.length} violations)`);

          server.close();
          resolve(score);
        },
      });

      await crawler.run([testUrl]);
    });
  });
}

async function generateEnhancedSite(): Promise<void> {
  try {
    // Read text content and color palette
    const textData = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'noah-text.json'), 'utf8'));
    const paletteData = JSON.parse(await fs.readFile(path.join(RAW_DIR, 'palette.json'), 'utf8'));

    const prompt = `Create a modern accessible website using this content and color scheme:

CONTENT: ${textData.texts.slice(0, 20).join(' ')}

COLORS: ${paletteData.colors.slice(0, 10).join(', ')}

REQUIREMENTS:
- Modern accessible site following WCAG 2.2 AA standards
- Built with Next.js, TypeScript, and Tailwind CSS
- Dark mode toggle support
- Minimum 44px tap targets for touch accessibility
- Semantic HTML5 structure with proper heading hierarchy
- Comprehensive ARIA labels and descriptions
- Skip navigation link for keyboard users
- Language attribute set to English (lang="en")
- Supports 200% zoom without horizontal scrolling
- Color contrast ratios ≥ 4.5:1 for normal text
- Keyboard navigation without focus traps
- Alt text for all images
- Form labels properly associated
- Error messages clearly announced to screen readers

Please create a complete, production-ready website that dramatically improves accessibility while maintaining visual appeal.`;

    console.log('📡 Calling v0.dev API...');

    const response = await fetch('https://api.v0.app/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: prompt,
        model: 'claude-3.5-sonnet'
      })
    });

    if (!response.ok) {
      throw new Error(`v0.dev API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.arrayBuffer();
    await fs.writeFile(path.join(ROOT_DIR, 'new-site.zip'), Buffer.from(result));

    // Extract and setup new site
    console.log('📦 Extracting enhanced site...');
    const zip = new AdmZip(Buffer.from(result));
    zip.extractAllTo(path.join(ROOT_DIR, 'new-site'), true);

    // Install dependencies and build
    console.log('📥 Installing dependencies...');
    await runCommand('npm install', path.join(ROOT_DIR, 'new-site'));

    console.log('🏗️  Building enhanced site...');
    await runCommand('npm run build', path.join(ROOT_DIR, 'new-site'));

  } catch (error) {
    console.error('❌ Failed to generate enhanced site:', error);
    throw error;
  }
}

async function runAxeAuditOnEnhanced(): Promise<number> {
  const outDir = path.join(ROOT_DIR, 'new-site', 'out');

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const filePath = req.url === '/' ? '/index.html' : req.url;
        const fullPath = path.join(outDir, filePath!);
        const content = await fs.readFile(fullPath, 'utf8');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch (error) {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start server'));
        return;
      }

      const testUrl = `http://localhost:${address.port}`;

      const { PlaywrightCrawler } = await import('crawlee');
      const crawler = new PlaywrightCrawler({
        headless: true,
        requestHandler: async ({ page }) => {
          await page.addScriptTag({ path: require.resolve('axe-core') });

          const results: AxeResult = await page.evaluate(() => {
            return new Promise((resolve) => {
              (window as any).axe.run((err: any, results: AxeResult) => {
                if (err) throw err;
                resolve(results);
              });
            });
          });

          const score = Math.max(0, 100 - results.violations.length);
          console.log(`✅ Enhanced site accessibility score: ${score}% (${results.violations.length} violations)`);

          server.close();
          resolve(score);
        },
      });

      await crawler.run([testUrl]);
    });
  });
}

function runCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(' ');
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
  });
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const targetUrl = process.argv[2] || 'https://noah-garden.com/noah';

  runPipeline(targetUrl)
    .then(({ autoBefore, autoAfter }) => {
      console.log('\n🎯 ACCESSIBILITY ENHANCEMENT RESULTS');
      console.log('=====================================');
      console.log(`BEFORE WCAG: ${autoBefore}%`);
      console.log(`AFTER  WCAG: ${autoAfter}%`);
      console.log(`IMPROVEMENT: +${autoAfter - autoBefore}%`);
    })
    .catch((error) => {
      console.error('❌ Pipeline failed:', error);
      process.exit(1);
    });
}