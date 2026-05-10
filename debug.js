const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log(`[CONSOLE] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', error => console.log(`[PAGE ERROR] ${error.message}`));
  
  await page.goto('http://localhost:8000');
  await page.waitForTimeout(500);
  
  console.log("Clicking btn-solo...");
  await page.click('#btn-solo');
  await page.waitForTimeout(500);

  console.log("Entering name and starting game...");
  await page.fill('#solo-name', 'Tester');
  await page.click('#btn-start-solo');

  // wait until we see #btn-guess (meaning the game screen is visible)
  await page.waitForSelector('#btn-guess', { timeout: 30000 });
  console.log("Game started!");

  // Wait for the map to finish initializing and staggered resizes to happen
  await page.waitForTimeout(2000);

  // Take a screenshot of the guess map
  await page.screenshot({ path: 'playwright_map_test.png' });

  // Let's get the bounding box of #guess-map
  const box = await page.evaluate(() => {
    const el = document.getElementById('guess-map');
    const rect = el.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  });
  console.log("Guess map dimensions:", box);

  await browser.close();
})();
