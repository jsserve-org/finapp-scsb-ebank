import { CaptchaUnreadableError, readCaptcha } from "./models";

export async function solveCaptcha(
  capture: () => Promise<Buffer>,
  refresh: () => Promise<void>,
  apiKey: string,
  model: string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readCaptcha(await capture(), apiKey, model);
    } catch (error) {
      if (!(error instanceof CaptchaUnreadableError) || attempt === 2) throw error;
      await refresh();
    }
  }
  throw new CaptchaUnreadableError("Luna could not confidently read the CAPTCHA after three images");
}
