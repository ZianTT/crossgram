import { useEffect, useMemo, useState } from 'react'
import type {
  Data,
  FieldInfo,
  TableInfo,
} from '@cordisjs/plugin-database-webui'
import { useConnectionState, useRpc, type PageProps } from '../sdk.js'
import { Icon } from '../icons.js'
import {
  ActionError,
  LiveContent,
  Modal,
  PageHeader,
  useAction,
  useAsync,
} from '../components.js'
import { displayValue, parseCell, primaryKey } from './admin-model.js'
const EMPTY_TABLES: TableInfo[] = []
export default function DatabasePage(props: PageProps) {
  const rpc = useRpc<Data>(props.entryId),
    connection = useConnectionState()
  const [table, setTable] = useState(''),
    [offset, setOffset] = useState(0),
    [size, setSize] = useState(50)
  const [sort, setSort] = useState<{
    field: string
    direction: 'asc' | 'desc'
  }>()
  const [editing, setEditing] = useState<{
    table: TableInfo
    row: any
    field: FieldInfo
  }>()
  const tables = rpc.data.tables ?? EMPTY_TABLES
  useEffect(() => {
    if (rpc.ready && !tables.some((item) => item.name === table)) {
      setTable(tables[0]?.name ?? '')
      setOffset(0)
    }
  }, [rpc.ready, tables, table])
  const current = useMemo(
    () => tables.find((item) => item.name === table),
    [tables, table],
  )
  const result = useAsync(
    () =>
      rpc.ready && table
        ? rpc.data.query({ table, offset, limit: size, sort })
        : undefined,
    [rpc.ready, table, offset, size, sort],
  )
  const snapshot = result.error ? undefined : result.data
  const chooseTable = (value: string) => {
    setTable(value)
    setOffset(0)
    setSort(undefined)
  }
  return (
    <>
      <PageHeader
        title="Database"
        description="Browse your data. Make precise, deliberate changes."
        actions={
          <button
            className="button outlined"
            disabled={!rpc.ready || result.loading}
            onClick={() => void result.reload()}
          >
            Refresh
          </button>
        }
      />
      <LiveContent ready={rpc.ready}>
        <div className="panel stack">
          <div className="toolbar">
            <label className="field">
              <span>Table</span>
              <select
                aria-label="Table"
                value={table}
                onChange={(event) => chooseTable(event.currentTarget.value)}
              >
                {tables.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Rows per page</span>
              <select
                aria-label="Rows per page"
                value={String(size)}
                onChange={(event) => {
                  setSize(+event.currentTarget.value)
                  setOffset(0)
                }}
              >
                {[25, 50, 100].map((count) => (
                  <option key={count} value={String(count)}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <span className="chip">{snapshot?.total ?? 0} rows</span>
          </div>
          <ActionError error={result.error ? String(result.error) : ''} />
          {!result.loading ? (
            <>
              {current ? (
                <div
                  className="table-scroll"
                  tabIndex={0}
                  aria-label="Database rows"
                >
                  <table>
                    <thead>
                      <tr>
                        {current.fields.map((field) => (
                          <th
                            key={field.name}
                            aria-sort={
                              sort?.field === field.name
                                ? sort?.direction === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : 'none'
                            }
                          >
                            <button
                              className="table-sort"
                              onClick={() => {
                                setOffset(0)
                                setSort({
                                  field: field.name,
                                  direction:
                                    sort?.field === field.name &&
                                    sort?.direction === 'asc'
                                      ? 'desc'
                                      : 'asc',
                                })
                              }}
                            >
                              {field.primary ? '⌑ ' : ''}
                              {field.name}
                              <small>{field.type}</small>
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(snapshot?.rows ?? []).map((row, index) => (
                        <tr key={index}>
                          {current.fields.map((field) => (
                            <td key={field.name}>
                              {!field.primary &&
                              field.type !== 'expr' &&
                              current.primary.length ? (
                                <button
                                  className="cell-edit"
                                  disabled={connection.status !== 'connected'}
                                  aria-label={
                                    'Edit ' +
                                    field.name +
                                    ' in row ' +
                                    current.primary
                                      .map((key) => displayValue(row[key]))
                                      .join(', ')
                                  }
                                  onClick={() =>
                                    setEditing({
                                      table: current,
                                      row,
                                      field,
                                    })
                                  }
                                >
                                  {displayValue(row[field.name]).slice(0, 240)}
                                </button>
                              ) : (
                                <span title={displayValue(row[field.name])}>
                                  {displayValue(row[field.name]).slice(0, 240)}
                                </span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {!snapshot?.rows.length ? (
                <p className="empty-note">
                  <Icon name="database" size={16} />
                  No rows in this table.
                </p>
              ) : null}
            </>
          ) : (
            <div className="loading" role="status">
              Reading this page…
            </div>
          )}
          <div className="pagination">
            <button
              className="button outlined"
              disabled={offset === 0 || result.loading}
              onClick={() => setOffset(Math.max(0, offset - size))}
            >
              Previous page
            </button>
            <span>Page {Math.floor(offset / size) + 1}</span>
            <button
              className="button outlined"
              disabled={
                result.loading || offset + size >= (snapshot?.total ?? 0)
              }
              onClick={() => setOffset(offset + size)}
            >
              Next page
            </button>
          </div>
          {current ? (
            <details>
              <summary>Table schema and primary keys</summary>
              <p className="muted">
                Primary key:{' '}
                {current.primary.join(', ') || 'none; table is read-only'}
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Constraints</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.fields.map((field) => (
                      <tr key={field.name}>
                        <td>{field.name}</td>
                        <td>{field.type}</td>
                        <td>
                          {[
                            field.primary && 'Primary',
                            field.unique && 'Unique',
                            field.nullable && 'Nullable',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </div>
      </LiveContent>
      {editing ? (
        <EditCell
          edit={editing}
          onClose={() => setEditing(undefined)}
          onSave={async (value) => {
            await rpc.data.update({
              table: editing.table.name,
              where: primaryKey(editing.row, editing.table.primary),
              field: editing.field.name,
              value,
            })
            setEditing(undefined)
            result.reload()
          }}
        />
      ) : null}
    </>
  )
}
function EditCell({
  edit,
  onClose,
  onSave,
}: {
  edit: { table: TableInfo; row: any; field: FieldInfo }
  onClose: () => void
  onSave: (value: unknown) => Promise<void>
}) {
  const original = edit.row[edit.field.name]
  const [text, setText] = useState(
    original === null ? '' : displayValue(original),
  )
  const [isNull, setNull] = useState(original === null),
    action = useAction()
  return (
    <Modal
      title={'Edit ' + edit.field.name}
      onClose={() => {
        if (!action.busy) onClose()
      }}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(() =>
            onSave(
              parseCell(text, edit.field.type, !!edit.field.nullable, isNull),
            ),
          )
        }}
      >
        <p className="muted">
          {edit.table.name} · primary key{' '}
          {JSON.stringify(primaryKey(edit.row, edit.table.primary))}
        </p>
        <label className="field">
          <span>Value ({edit.field.type})</span>
          <textarea
            value={text}
            disabled={isNull || action.busy}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        {edit.field.nullable ? (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={isNull}
              onChange={(event) => setNull(event.currentTarget.checked)}
            />
            Set to null
          </label>
        ) : null}
        <ActionError error={action.error} />
        <button className="button filled" disabled={action.busy}>
          {action.busy ? 'Saving…' : 'Save cell'}
        </button>
      </form>
    </Modal>
  )
}
