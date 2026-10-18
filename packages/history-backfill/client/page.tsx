/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import {
  ActionError, EmptyState, formatNumber, LiveContent, PageHeader, useAction,
} from 'cordis-webui-solidjs/components'
import type {
  BackfillConversationSnapshot, BackfillSessionSnapshot, BackfillSnapshot, HistoryBackfillData,
} from '../src/types.js'
import {
  conversationProgress, formatAge, formatDate, sessionStatusLabel,
} from './model.js'

export default function HistoryBackfillPage(props: PageProps) {
  const rpc = useRpc<HistoryBackfillData>(props.entryId)
  const toggle = useAction()
  return (
    <>
      <PageHeader
        icon="clock"
        title="History backfill"
        description="While an account is idle, slowly read back older and missing group history into the local store."
        actions={
          <Show when={rpc.data.snapshot}>
            {(snapshot) => (
              <button
                class={`button ${snapshot().enabled ? 'outlined' : 'filled'}`}
                disabled={toggle.busy()}
                onClick={() => toggle.run(() => rpc.data.setEnabled(!snapshot().enabled))}
              >
                {snapshot().enabled ? 'Pause backfill' : 'Start backfill'}
              </button>
            )}
          </Show>
        }
      />
      <ActionError error={toggle.error()} />
      <LiveContent ready={rpc.ready}>
        <Show when={rpc.data.snapshot}>
          {(snapshot) => <BackfillDashboard snapshot={snapshot()} data={rpc.data} />}
        </Show>
      </LiveContent>
    </>
  )
}

export function BackfillDashboard(props: { snapshot: BackfillSnapshot, data: HistoryBackfillData }) {
  const settings = () => props.snapshot.settings
  return (
    <div class="stack history-backfill">
      <p class="muted">
        {props.snapshot.enabled ? 'Running' : 'Paused'}
        {' · '}idle after {Math.round(settings().idleAfterMs / 1000)}s
        {' · '}one request every ≥{(settings().intervalMs / 1000).toFixed(1)}s
        {' · '}{settings().pageSize} messages per request
        {' · '}{settings().maxAgeDays ? `up to ${settings().maxAgeDays} days back` : 'no age limit'}
        {' · '}progress is kept in memory and rebuilt from stored messages after a restart
      </p>
      <Show
        when={props.snapshot.sessions.length}
        fallback={<EmptyState icon="clock" title="No active accounts" description="Backfill starts once a platform account is online." />}
      >
        <For each={props.snapshot.sessions}>
          {(session) => <SessionPanel session={session} data={props.data} />}
        </For>
      </Show>
      <Show when={props.snapshot.recent.length}>
        <section class="panel">
          <h3>Recent requests</h3>
          <div class="table-scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Conversation</th><th>Kind</th><th>Range</th><th>Fetched</th><th>New</th><th>Error</th></tr>
              </thead>
              <tbody>
                <For each={props.snapshot.recent}>
                  {(event) => (
                    <tr>
                      <td>{formatDate(event.at)}</td>
                      <td>{event.title}</td>
                      <td>{event.kind === 'gap' ? 'gap' : 'older'} · {event.mode}</td>
                      <td>{event.range}</td>
                      <td>{formatNumber(event.fetched)}</td>
                      <td>{formatNumber(event.inserted)}</td>
                      <td>{event.error ?? ''}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>
      </Show>
    </div>
  )
}

function SessionPanel(props: { session: BackfillSessionSnapshot, data: HistoryBackfillData }) {
  const [filter, setFilter] = createSignal<'pending' | 'all'>('pending')
  const reset = useAction()
  const rows = createMemo(() => props.session.conversations.filter((item) =>
    filter() === 'all' || !(item.floorReached && item.gapCount === 0)))
  return (
    <section class="panel">
      <header>
        <h3>{props.session.platformId} · {props.session.platformSessionId}</h3>
        <span class="muted">{sessionStatusLabel(props.session.status)}</span>
      </header>
      <div class="metric-grid compact-metrics">
        <div class="metric"><span>Conversations</span><strong>{formatNumber(props.session.totals.conversations)}</strong><p>{formatNumber(props.session.totals.complete)} fully backfilled</p></div>
        <div class="metric"><span>Known gaps</span><strong>{formatNumber(props.session.totals.gaps)}</strong><p>{formatNumber(props.session.totals.missing)} sequence numbers missing</p></div>
        <div class="metric"><span>Fetched</span><strong>{formatNumber(props.session.totals.fetched)}</strong><p>{formatNumber(props.session.totals.inserted)} new messages stored</p></div>
        <div class="metric"><span>Requests today</span><strong>{formatNumber(props.session.requestsToday)}</strong><p>limit {formatNumber(props.session.dailyRequestCap)} · last client activity {formatAge(props.session.lastActivityAt)}</p></div>
      </div>
      <div class="toolbar">
        <div class="segmented" role="tablist" aria-label="Conversation filter">
          <button role="tab" aria-selected={filter() === 'pending'} classList={{ selected: filter() === 'pending' }} onClick={() => setFilter('pending')}>Pending</button>
          <button role="tab" aria-selected={filter() === 'all'} classList={{ selected: filter() === 'all' }} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>
      <ActionError error={reset.error()} />
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Conversation</th><th>Mode</th><th>Progress</th><th>Gaps</th><th>Oldest</th><th>Fetched</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(item) => <ConversationRow item={item} onReset={() => reset.run(() =>
                props.data.resetConversation(props.session.platformSessionId, item.conversationId))} />}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ConversationRow(props: { item: BackfillConversationSnapshot, onReset: () => void }) {
  const item = () => props.item
  return (
    <tr>
      <td>{item().title}</td>
      <td>{item().mode === 'sequence' ? 'msgSeq' : 'anchor'}</td>
      <td>{conversationProgress(item())}</td>
      <td>{item().gapCount ? `${formatNumber(item().gapCount)} (${formatNumber(item().missing)})` : '—'}</td>
      <td>{item().oldestTimestamp ? formatDate(item().oldestTimestamp! * 1000) : '—'}</td>
      <td>{formatNumber(item().fetched)} / {formatNumber(item().inserted)} new</td>
      <td>
        {item().lastError
          ? `retry ${formatAge(item().nextAttemptAt)} · ${item().lastError}`
          : item().floorReached
            ? item().floorReason === 'age' ? 'reached age limit' : 'reached the beginning'
            : 'pending'}
      </td>
      <td>
        <Show when={item().failures || item().floorReached}>
          <button class="button tonal" onClick={() => props.onReset()}>Retry</button>
        </Show>
      </td>
    </tr>
  )
}
