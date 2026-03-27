/**
 * Downloads the same MiniLM embedding GGUF that llamacpp-extension fetches on first embed().
 * Run from copy:assets:tauri so release bundles ship without a Hugging Face round-trip.
 *
 * URL must stay in sync with extensions/llamacpp-extension/src/index.ts embed().
 */
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const DEST = path.join(
  REPO_ROOT,
  'src-tauri/resources/bundled-models/sentence-transformer-mini/model.gguf'
)
const MODEL_DOWNLOAD_URL =
  'https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF/resolve/main/all-MiniLM-L6-v2-ggml-model-f16.gguf?download=true'

/** Expect ~43 MiB; skip re-download if file looks complete */
const MIN_BYTES = 35 * 1024 * 1024

function downloadFollowRedirects(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.part`

    const run = (currentUrl) => {
      https
        .get(currentUrl, (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume()
            run(new URL(response.headers.location, currentUrl).href)
            return
          }
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `GET ${currentUrl} failed: ${response.statusCode ?? 'unknown'}`
              )
            )
            return
          }
          const file = fs.createWriteStream(tmp)
          response.pipe(file)
          file.on('finish', () => {
            file.close(() => {
              fs.renameSync(tmp, dest)
              resolve()
            })
          })
        })
        .on('error', (err) => {
          try {
            fs.unlinkSync(tmp)
          } catch {
            /* ignore */
          }
          reject(err)
        })
    }

    run(url)
  })
}

async function main() {
  try {
    if (fs.existsSync(DEST)) {
      const st = fs.statSync(DEST)
      if (st.size >= MIN_BYTES) {
        console.log(
          `[download-bundled-embedding-model] Already present (${st.size} bytes), skip`
        )
        return
      }
      fs.unlinkSync(DEST)
    }
    console.log(`[download-bundled-embedding-model] Downloading to ${DEST}`)
    await downloadFollowRedirects(MODEL_DOWNLOAD_URL, DEST)
    const size = fs.statSync(DEST).size
    console.log(`[download-bundled-embedding-model] Done (${size} bytes)`)
  } catch (e) {
    console.error('[download-bundled-embedding-model]', e)
    process.exit(1)
  }
}

main()
