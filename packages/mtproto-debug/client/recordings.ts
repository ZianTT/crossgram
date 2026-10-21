import type { RecordingSummary } from '../src/recordings.js'
import { readResponse, sameOriginPath } from 'cordis-webui-react/utils'
/** Same budget as the capture pages; recordings are small JSON documents. */
export const RECORDING_TIMEOUT_MS = 10_000
const MAX_RECORDING_RESPONSE_BYTES = 1024 * 1024
/** The saved-log index plus the server folder it is stored in. */
export interface SavedLogs {
  directory: string
  recordings: RecordingSummary[]
}
/** `id` is appended as a single encoded path segment, never as a query value. */
function recordingUrl(endpoint: string, id?: string): string {
  const base = sameOriginPath(endpoint).replace(/\/+$/, '')
  return id === undefined ? base : base + '/' + encodeURIComponent(id)
}
/**
 * The unsaved snapshot endpoint: the same self-describing document as a saved
 * log, written straight to the browser as an attachment.
 */
export function currentLogDownloadUrl(endpoint: string, label?: string): string {
  const url = new URL(recordingUrl(endpoint) + '/current')
  const trimmed = label?.trim()
  if (trimmed) url.searchParams.set('label', trimmed)
  return url.href
}
function httpError(text: string, status: number, failure: string): string {
  try {
    const value = JSON.parse(text) as { error?: unknown }
    if (typeof value.error === 'string' && value.error) return value.error
  } catch {
    // Fall through to the status line below.
  }
  const detail = text.trim().slice(0, 200)
  return failure + ': HTTP ' + status + (detail ? ' (' + detail + ')' : '')
}
async function requestJson(
  url: string,
  failure: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RECORDING_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
        signal: controller.signal,
      })
    } catch (cause) {
      throw controller.signal.aborted
        ? new Error(failure + ': request timed out')
        : cause
    }
    const result = await readResponse(response, MAX_RECORDING_RESPONSE_BYTES)
    if (result.truncated) throw new Error(failure + ': response is too large')
    if (!response.ok)
      throw new Error(httpError(result.text, response.status, failure))
    try {
      return JSON.parse(result.text)
    } catch {
      throw new Error(failure + ': invalid JSON response')
    }
  } finally {
    clearTimeout(timeout)
  }
}
export async function listRecordings(
  endpoint: string,
): Promise<SavedLogs> {
  const payload = await requestJson(
    recordingUrl(endpoint),
    'Could not load saved logs',
    { method: 'GET' },
  )
  const recordings = (payload as { recordings?: unknown }).recordings
  const directory = (payload as { directory?: unknown }).directory
  if (!Array.isArray(recordings) || typeof directory !== 'string')
    throw new Error('Could not load saved logs: invalid response')
  return { recordings: recordings as RecordingSummary[], directory }
}
export async function saveRecording(
  endpoint: string,
  label?: string,
): Promise<RecordingSummary> {
  const trimmed = label?.trim()
  const payload = await requestJson(
    recordingUrl(endpoint),
    'Could not save log',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(trimmed ? { label: trimmed } : {}),
    },
  )
  const recording = (payload as { recording?: unknown }).recording
  if (
    !recording ||
    typeof recording !== 'object' ||
    typeof (recording as RecordingSummary).id !== 'string'
  )
    throw new Error('Could not save log: invalid response')
  return recording as RecordingSummary
}
export async function deleteRecording(
  endpoint: string,
  id: string,
): Promise<string> {
  const payload = await requestJson(
    recordingUrl(endpoint, id),
    'Could not delete log',
    { method: 'DELETE' },
  )
  const deleted = (payload as { deleted?: unknown }).deleted
  if (typeof deleted !== 'string')
    throw new Error('Could not delete log: invalid response')
  return deleted
}
export function recordingDownloadUrl(endpoint: string, id: string): string {
  return recordingUrl(endpoint, id)
}
export type { RecordingSummary } from '../src/recordings.js'

