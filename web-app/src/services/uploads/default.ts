import type { UploadsService, UploadResult } from './types'
import type { Attachment } from '@/types/attachment'
import { ulid } from 'ulidx'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, type RAGExtension, type IngestAttachmentsResult } from '@janhq/core'

const tauriInvoke = (...args: Parameters<typeof window.__TAURI_INTERNALS__.invoke>) =>
  window.__TAURI_INTERNALS__.invoke(...args)

export class DefaultUploadsService implements UploadsService {
  async ingestImage(_threadId: string, attachment: Attachment): Promise<UploadResult> {
    if (attachment.type !== 'image') throw new Error('ingestImage: attachment is not image')
    // Placeholder upload flow; swap for real API call when backend is ready
    await new Promise((r) => setTimeout(r, 100))
    return { id: ulid() }
  }

  async ingestFileAttachment(threadId: string, attachment: Attachment): Promise<UploadResult> {
    if (attachment.type !== 'document') throw new Error('ingestFileAttachment: attachment is not document')

    const collection = `attachments_${threadId}`
    const filePath = attachment.path!
    const fileType = attachment.fileType || 'application/octet-stream'

    // Step-by-step Tauri command diagnostic
    console.log('[ingest:diag] === STEP-BY-STEP INGEST DIAGNOSTIC ===')
    console.log('[ingest:diag] collection:', collection, 'filePath:', filePath)

    // Step 1: Test vector-db plugin accessibility
    console.log('[ingest:diag] Step 1: get_status...')
    try {
      const status = await tauriInvoke('plugin:vector-db|get_status')
      console.log('[ingest:diag] Step 1 OK:', JSON.stringify(status))
    } catch (e) {
      console.error('[ingest:diag] Step 1 FAILED:', e)
    }

    // Step 2: list_attachments (check duplicates)
    console.log('[ingest:diag] Step 2: list_attachments...')
    try {
      const files = await tauriInvoke('plugin:vector-db|list_attachments', { collection })
      console.log('[ingest:diag] Step 2 OK, files:', Array.isArray(files) ? files.length : files)
    } catch (e) {
      console.log('[ingest:diag] Step 2 error (expected for new collection):', String(e))
    }

    // Step 3: parse_document
    console.log('[ingest:diag] Step 3: parse_document...')
    let parsedText = ''
    try {
      parsedText = await tauriInvoke('plugin:rag|parse_document', { filePath, fileType }) as string
      console.log('[ingest:diag] Step 3 OK, text length:', parsedText?.length)
    } catch (e) {
      console.error('[ingest:diag] Step 3 FAILED:', e)
      throw e
    }

    // Step 4: chunk_text
    console.log('[ingest:diag] Step 4: chunk_text...')
    let chunks: string[] = []
    try {
      chunks = await tauriInvoke('plugin:vector-db|chunk_text', { text: parsedText, chunkSize: 512, chunkOverlap: 64 }) as string[]
      console.log('[ingest:diag] Step 4 OK, chunks:', chunks?.length)
    } catch (e) {
      console.error('[ingest:diag] Step 4 FAILED:', e)
      throw e
    }

    // Step 5: embed — FULL MANUAL DIAGNOSTIC (bypass extension entirely)
    console.log('[ingest:diag] Step 5: === MANUAL EMBED DIAGNOSTIC ===')

    // 5a: find existing session via Tauri command
    console.log('[ingest:diag] Step 5a: find_session_by_model...')
    type SInfo = { pid: number; port: number; model_id: string; api_key: string; is_embedding: boolean } | null
    let sInfo: SInfo = null
    try {
      const p = tauriInvoke('plugin:llamacpp|find_session_by_model', { modelId: 'sentence-transformer-mini' })
      const t = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: find_session_by_model (5s) => Mutex held!')), 5000))
      sInfo = await Promise.race([p, t]) as SInfo
      console.log('[ingest:diag] Step 5a OK, session:', JSON.stringify(sInfo))
    } catch (e) {
      console.error('[ingest:diag] Step 5a FAILED:', e)
      // secondary check
      try {
        const p2 = tauriInvoke('plugin:llamacpp|get_loaded_models')
        const t2 = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: get_loaded_models (5s)')), 5000))
        const models = await Promise.race([p2, t2])
        console.log('[ingest:diag] Step 5a-fallback get_loaded_models OK:', JSON.stringify(models))
      } catch (e2) {
        console.error('[ingest:diag] Step 5a-fallback ALSO FAILED:', e2, '=> MUTEX DEADLOCKED')
      }
      throw e
    }

    // 5b: if no session, load the model via extension (and capture its promise behavior)
    if (!sInfo) {
      console.log('[ingest:diag] Step 5b: No session found, loading model via extension...')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const llm = (window as any).core?.extensionManager?.getByName('@janhq/llamacpp-extension')
      if (!llm) throw new Error('llamacpp extension not available')
      try {
        const loadP = llm.load.call(llm, 'sentence-transformer-mini', undefined, true) as Promise<SInfo>
        const loadT = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: llm.load() (120s)')), 120000))
        sInfo = await Promise.race([loadP, loadT])
        console.log('[ingest:diag] Step 5b OK, loaded session:', JSON.stringify(sInfo))
      } catch (e) {
        console.error('[ingest:diag] Step 5b FAILED:', e)
        throw e
      }
    }

    if (!sInfo) throw new Error('No session info after load')

    // 5c: Direct HTTP fetch to the embedding server
    const embedPort = sInfo.port
    const embedApiKey = sInfo.api_key
    const embedUrl = `http://localhost:${embedPort}/v1/embeddings`
    console.log('[ingest:diag] Step 5c: fetch POST', embedUrl, 'chunks:', chunks.length)

    let embedRes: { data: Array<{ embedding: number[]; index: number }> }
    try {
      const fetchP = fetch(embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${embedApiKey}` },
        body: JSON.stringify({ input: chunks, model: sInfo.model_id, encoding_format: 'float' }),
      })
      const fetchT = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: fetch /v1/embeddings (30s)')), 30000))
      const response = await Promise.race([fetchP, fetchT])
      console.log('[ingest:diag] Step 5c: fetch returned, status:', response.status)

      if (!response.ok) {
        const errBody = await response.text().catch(() => '<unreadable>')
        throw new Error(`Embed HTTP ${response.status}: ${errBody}`)
      }

      console.log('[ingest:diag] Step 5c: parsing response body...')
      const jsonP = response.json()
      const jsonT = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: response.json() (10s)')), 10000))
      embedRes = await Promise.race([jsonP, jsonT]) as { data: Array<{ embedding: number[]; index: number }> }
      console.log('[ingest:diag] Step 5c OK, got', embedRes?.data?.length, 'embeddings')
    } catch (e) {
      console.error('[ingest:diag] Step 5c FAILED:', e)
      throw e
    }
    const embeddings: number[][] = new Array(chunks.length)
    for (const item of embedRes?.data || []) embeddings[item.index] = item.embedding
    const dimension = embeddings[0]?.length || 0
    console.log('[ingest:diag] Step 5 OK, dimension:', dimension, 'embeddings:', embeddings.length)

    if (dimension <= 0) throw new Error('Embedding dimension not available')

    // Step 6: create_collection
    console.log('[ingest:diag] Step 6: create_collection...')
    try {
      await tauriInvoke('plugin:vector-db|create_collection', { name: collection, dimension })
      console.log('[ingest:diag] Step 6 OK')
    } catch (e) {
      console.error('[ingest:diag] Step 6 FAILED:', e)
      throw e
    }

    // Step 7: create_file
    console.log('[ingest:diag] Step 7: create_file...')
    let fileInfo: { id: string; chunk_count?: number; size?: number }
    try {
      fileInfo = await tauriInvoke('plugin:vector-db|create_file', {
        collection,
        file: { path: filePath, name: attachment.name, type: fileType, size: attachment.size ?? null },
      }) as { id: string; chunk_count?: number; size?: number }
      console.log('[ingest:diag] Step 7 OK, fileId:', fileInfo?.id)
    } catch (e) {
      console.error('[ingest:diag] Step 7 FAILED:', e)
      throw e
    }

    // Step 8: insert_chunks
    console.log('[ingest:diag] Step 8: insert_chunks...')
    try {
      await tauriInvoke('plugin:vector-db|insert_chunks', {
        collection,
        fileId: fileInfo.id,
        chunks: chunks.map((t, i) => ({ text: t, embedding: embeddings[i] })),
      })
      console.log('[ingest:diag] Step 8 OK')
    } catch (e) {
      console.error('[ingest:diag] Step 8 FAILED:', e)
      throw e
    }

    console.log('[ingest:diag] === ALL STEPS COMPLETED ===')
    return {
      id: fileInfo.id,
      size: typeof fileInfo.size === 'number' ? Number(fileInfo.size) : undefined,
      chunkCount: typeof fileInfo.chunk_count === 'number' ? Number(fileInfo.chunk_count) : undefined,
    }
  }

  async ingestFileAttachmentForProject(projectId: string, attachment: Attachment): Promise<UploadResult> {
    if (attachment.type !== 'document') throw new Error('ingestFileAttachmentForProject: attachment is not document')
    const ext = ExtensionManager.getInstance().get<RAGExtension>(ExtensionTypeEnum.RAG)
    if (!ext?.ingestAttachmentsForProject) throw new Error('RAG extension does not support project-level ingestion')
    const res: IngestAttachmentsResult = await ext.ingestAttachmentsForProject(projectId, [
      { path: attachment.path!, name: attachment.name, type: attachment.fileType, size: attachment.size },
    ])
    const files = res.files
    if (Array.isArray(files) && files[0]?.id) {
      return {
        id: files[0].id,
        size: typeof files[0].size === 'number' ? Number(files[0].size) : undefined,
        chunkCount: typeof files[0].chunk_count === 'number' ? Number(files[0].chunk_count) : undefined,
      }
    }
    throw new Error('Failed to resolve ingested attachment id')
  }
}
