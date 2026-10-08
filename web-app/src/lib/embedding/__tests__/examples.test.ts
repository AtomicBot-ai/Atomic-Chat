import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  embeddingImageCommand,
  embeddingTextCommand,
  shellQuote,
} from '../examples'

const ENDPOINT = 'http://127.0.0.1:1337/v1/embeddings'

/** The smallest PNG there is: one red pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mO4IyICAALUAQVnjQBuAAAAAElFTkSuQmCC',
  'base64'
)

const hasShellTools =
  process.platform !== 'win32' &&
  ['file', 'base64', 'tr'].every(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0
  )

describe('embeddingTextCommand', () => {
  it('sends the model its own query prefix, as floats', () => {
    const command = embeddingTextCommand(
      ENDPOINT,
      'embeddinggemma-2',
      'task: search result | query: ',
      false
    )
    expect(command).toBe(
      [
        `curl -X POST '${ENDPOINT}' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"model":"embeddinggemma-2","input":"task: search result | query: Why is the sky blue?","encoding_format":"float"}'`,
      ].join('\n')
    )
  })

  it('adds the key header when the server needs one, and no prefix for a model without', () => {
    const command = embeddingTextCommand(ENDPOINT, 'bge-m3', '', true)
    expect(command).toContain(`-H 'Authorization: Bearer YOUR_API_KEY' \\`)
    expect(command).toContain('"input":"Why is the sky blue?"')
  })

  it('quotes for the shell what the shell would read', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(embeddingTextCommand(ENDPOINT, "o'brien", '', false)).toContain(
      `"model":"o'\\''brien"`
    )
  })
})

describe('embeddingImageCommand', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reads the file named in IMAGE and streams the request through stdin', () => {
    const command = embeddingImageCommand(ENDPOINT, 'embeddinggemma-2', true)
    expect(command.split('\n')[0]).toBe('IMAGE=photo.jpg')
    expect(command).toContain('base64 < "$IMAGE"')
    expect(command).toContain('--data-binary @-')
    expect(command).toContain(`-H 'Authorization: Bearer YOUR_API_KEY' \\`)
    expect(command).not.toContain('#')
    expect(command).not.toContain('base64,...')
  })

  it.skipIf(!hasShellTools)(
    'sends a JSON body whose data: URL holds the whole file, with the type read from its bytes',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'atomic-embedding-example-'))
      writeFileSync(join(dir, 'photo.jpg'), PNG)
      // A curl that keeps what it was sent and where.
      writeFileSync(
        join(dir, 'curl'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/body"\n`
      )
      chmodSync(join(dir, 'curl'), 0o755)

      const run = spawnSync(
        'sh',
        ['-c', embeddingImageCommand(ENDPOINT, 'embeddinggemma-2', false)],
        {
          cwd: dir,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
        }
      )
      expect(run.status).toBe(0)

      const body = JSON.parse(readFileSync(join(dir, 'body'), 'utf8'))
      expect(body).toMatchObject({
        model: 'embeddinggemma-2',
        encoding_format: 'float',
      })
      const url: string = body.input[0].content[0].image_url.url
      expect(url.startsWith('data:image/png;base64,')).toBe(true)
      expect(
        Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').equals(PNG)
      ).toBe(true)
      expect(readFileSync(join(dir, 'args'), 'utf8')).toContain(ENDPOINT)
    }
  )
})
