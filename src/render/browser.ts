import { chromium, type Browser, type LaunchOptions } from "playwright";

/** Launch Chromium, turning the "not installed" error into a clear, actionable message. */
export async function launchChromium(opts?: LaunchOptions): Promise<Browser> {
  try {
    return await chromium.launch(opts);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/Executable doesn't exist|playwright install|Failed to launch|spawn .* ENOENT/.test(msg)) {
      throw new Error("Chromium for Playwright isn't installed. Run:\n  npx playwright install chromium");
    }
    throw e;
  }
}
