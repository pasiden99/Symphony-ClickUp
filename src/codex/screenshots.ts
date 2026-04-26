import { chromium } from "playwright";

export interface ScreenshotCaptureRequest {
  url: string;
  outputPath: string;
  viewport: {
    width: number;
    height: number;
  };
  fullPage: boolean;
  waitMs: number;
}

export interface ScreenshotCapturer {
  capture(request: ScreenshotCaptureRequest): Promise<void>;
}

export class PlaywrightScreenshotCapturer implements ScreenshotCapturer {
  async capture(request: ScreenshotCaptureRequest): Promise<void> {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: {
          width: request.viewport.width,
          height: request.viewport.height
        }
      });
      try {
        const page = await context.newPage();
        await page.goto(request.url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000
        });
        if (request.waitMs > 0) {
          await page.waitForTimeout(request.waitMs);
        }
        await page.screenshot({
          path: request.outputPath,
          fullPage: request.fullPage
        });
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
}
