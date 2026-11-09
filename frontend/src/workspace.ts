import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick, type UnwrapNestedRefs } from 'vue'
import {
  api,
  ApiError,
  isPreview,
  type Account,
  type Batch,
  type BatchRequest,
  type ClientKey,
  type RecordEntry,
} from './api'
import { accountDisplayName, active, executionState, label, verdict } from './presentation'
export function workspace() {
  const nav = ref<'test' | 'history'>('test'),
    kind = ref('fingerprint'),
    model = ref(''),
    keyId = ref(''),
    effort = ref(''),
    profile = ref('simple-v1'),
    repeats = ref(1),
    outputVersion = ref('svg-v1'),
    concurrency = ref(2)
  const accounts = ref<Account[]>([]),
    keys = ref<ClientKey[]>([]),
    models = ref<string[]>([]),
    records = ref<RecordEntry[]>([]),
    batches = ref<Batch[]>([]),
    selected = ref<string[]>([]),
    focus = ref(''),
    currentBatchId = ref(''),
    historyId = ref(''),
    legacyId = ref('')
  const error = ref(''),
    notice = ref(''),
    busy = ref(false),
    loading = ref(true),
    modelLoading = ref(false),
    reportLoading = ref(false),
    pending = ref<BatchRequest | null>(null),
    accountSearch = ref(''),
    accountPage = ref(0),
    mobileAccounts = ref(false),
    resultRecords = ref<RecordEntry[]>([])
  const filterKind = ref(''),
    filterAccount = ref(''),
    filterStatus = ref(''),
    filterDate = ref(''),
    clock = ref(Date.now()),
    comparison = ref<RecordEntry[]>([]),
    gallery = ref<RecordEntry[]>([]),
    comparisonCandidate = ref<RecordEntry | null>(null),
    detailOpen = ref(false),
    syncError = ref(''),
    lastSyncedAt = ref<number | null>(null),
    filterVerdict = ref('')
  const workspaceConflict = ref(false)
  let workspaceVersion: number | null = null,
    saveQueue: Promise<void> = Promise.resolve(),
    lastSaved = ''
  const drafts: Record<
    string,
    {
      effort: string
      profile: string
      repeats: number
      outputVersion: string
      batchId: string
      focus: string
    }
  > = {}
  const details = new Map<string, RecordEntry>(),
    sampleCache = new Map<string, RecordEntry['samples'][number]>()
  let disposed = false,
    timer: ReturnType<typeof setTimeout>,
    sequence = 0,
    reportSequence = 0,
    restoring = true,
    testFocus = '',
    testScroll = 0,
    historyScroll = 0,
    historyListScroll = 0,
    testDetailOpen = false
  function persist(strict = false): Promise<void> {
    const serialized = JSON.stringify({
      kind: kind.value,
      model: model.value,
      keyId: keyId.value,
      selected: selected.value,
      focus: nav.value === 'history' ? testFocus : focus.value,
      batchId: currentBatchId.value,
      drafts,
      pending: pending.value,
      effort: effort.value,
      profile: profile.value,
      repeats: repeats.value,
      outputVersion: outputVersion.value,
    })
    const operation = saveQueue.then(async () => {
      if (isPreview || disposed) return
      if (workspaceConflict.value) throw Error('页面草稿已在其他页面变化，请刷新读取')
      if (serialized === lastSaved) return
      try {
        const saved = await api.saveWorkspace(JSON.parse(serialized), workspaceVersion)
        workspaceVersion = saved.version
        lastSaved = serialized
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) workspaceConflict.value = true
        throw e
      }
    })
    saveQueue = operation.catch(() => {})
    if (strict) return operation
    void operation.catch((e) => (error.value = '无法保存页面草稿：' + (e as Error).message))
    return saveQueue
  }
  async function readWorkspace() {
    const stored = await api.workspace()
    workspaceVersion = stored.version
    workspaceConflict.value = false
    const saved = stored.draft
    if (!saved) return
    kind.value = saved.kind
    model.value = saved.model
    keyId.value = saved.keyId
    selected.value = saved.selected
    currentBatchId.value = saved.batchId
    focus.value = saved.focus
    for (const key in drafts) delete drafts[key]
    Object.assign(drafts, saved.drafts)
    pending.value = saved.pending
    effort.value = saved.effort
    profile.value = saved.profile
    repeats.value = saved.repeats
    outputVersion.value = saved.outputVersion
    lastSaved = JSON.stringify(saved)
  }
  const currentBatch = computed(() =>
    batches.value.find(
      (b) => b.request.id === (nav.value === 'history' ? historyId.value : currentBatchId.value),
    ),
  )
  const batchRows = computed(() =>
    currentBatch.value
      ? records.value.filter((r) => r.batchId === currentBatch.value!.request.id)
      : [],
  )
  const batchAccounts = computed(() => currentBatch.value?.request.accountIds ?? [])
  const currentRows = computed(() =>
    nav.value === 'history' && legacyId.value
      ? records.value.filter((r) => r.id === legacyId.value)
      : batchRows.value
          .filter((r) => r.accountId === focus.value)
          .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
  )
  const accountLabel = (id: string) => {
    const account = accounts.value.find((a) => a.account_id === id)
    return account
      ? accountDisplayName(account)
      : records.value
          .find((r) => r.accountId === id && r.accountName?.trim())
          ?.accountName?.trim() || id
  }
  const recordLabel = (row: RecordEntry) => row.accountName?.trim() || accountLabel(row.accountId)
  const batchAccountLabel = (batch: Batch, id: string) => {
    const saved = records.value.find(row => row.batchId === batch.request.id && row.accountId === id && row.accountName?.trim())
    return saved ? recordLabel(saved) : accountLabel(id)
  }
  const filteredAccounts = computed(() =>
    accounts.value.filter((a) =>
      [a.name, a.email ?? '', a.account_id]
        .join(' ')
        .toLowerCase()
        .includes(accountSearch.value.trim().toLowerCase()),
    ),
  )
  const pageAccounts = computed(() =>
    filteredAccounts.value.slice(accountPage.value * 20, (accountPage.value + 1) * 20),
  )
  const planned = computed(
    () =>
      selected.value.length *
      (kind.value === 'fingerprint' ? 3 : kind.value === 'candy' ? repeats.value : 1),
  )
  const readinessReason = computed(() => {
    if (isPreview) return '请从 CPR 插件入口打开'
    if (loading.value) return '正在读取账号与配置'
    if (workspaceConflict.value) return '草稿已在其他页面变化，请刷新读取'
    if (pending.value) return '上次提交尚未确认，请先核对原批次'
    if (busy.value) return '正在保存操作'
    if (!keyId.value) return keys.value.length ? '请选择客户端 Key' : '暂无可用客户端 Key'
    if (modelLoading.value) return '正在读取模型'
    if (!model.value) return models.value.length ? '请选择模型' : '所选 Key 暂无可用模型'
    if (!selected.value.length) return '请选择至少一个可用账号'
    return ''
  })
  const ready = computed(() => !readinessReason.value)
  const running = computed(() => batchRows.value.some(active))
  const globalRunning = computed(() => records.value.some(active))
  const historyDetail = computed(() => !!historyId.value || !!legacyId.value)
  const batchState = (b: Batch) => {
    const rows = records.value.filter((r) => r.batchId === b.request.id)
    if (!b.ready && !b.stopped) return 'uncertain'
    if (rows.some(active)) return 'active'
    if (b.stopped || rows.length > 0 && rows.every((r) => executionState(r) === 'stopped')) return 'stopped'
    if (rows.some((r) => r.status === 'paused' || r.status === 'stopped')) return 'paused'
    if (rows.some((r) => executionState(r) === 'failed')) return 'failed'
    if (rows.length < b.taskIds.length) return 'evicted'
    return 'completed'
  }
  const batchStatus = (b: Batch) => ({
    uncertain: '待确认提交', active: '检测中', stopped: '已停止',
    paused: '部分完成', failed: '执行失败', evicted: '部分记录已淘汰', completed: '全部完成',
  })[batchState(b)]
  const completedAccounts = computed(() =>
    batchAccounts.value.filter((id) => {
      const rows = batchRows.value.filter((r) => r.accountId === id)
      return rows.length > 0 && rows.every((r) => r.status === 'completed')
    }),
  )
  const waitingAccounts = computed(() =>
    batchAccounts.value.filter((id) =>
      batchRows.value.some((r) => r.accountId === id && r.status === 'paused'),
    ),
  )
  const accountStatus = (id: string) => {
    const rs = batchRows.value.filter((r) => r.accountId === id)
    if (!rs.length) return '可用'
    const live = rs.find(active)
    return live
      ? label(live)
      : rs.some((r) => r.status === 'paused')
        ? '等待处理'
        : currentBatch.value?.request.kind === 'candy'
          ? `${rs.filter((r) => r.verdict === 'correct').length} / ${rs.filter((r) => r.status === 'completed').length} 正确`
          : label(rs.at(-1)!)
  }
  const historyItems = computed(() =>
    batches.value.filter(
      (b) =>
        (!filterKind.value || b.request.kind === filterKind.value) &&
        (!filterAccount.value || b.request.accountIds.includes(filterAccount.value)) &&
        (!filterStatus.value || batchState(b) === filterStatus.value) &&
        (!filterVerdict.value || records.value.some((r) =>
          r.batchId === b.request.id &&
          (!filterAccount.value || r.accountId === filterAccount.value) &&
          executionState(r) === 'completed' && verdict(r) === filterVerdict.value,
        )) &&
        (!filterDate.value ||
          new Date(b.startedAt).toLocaleDateString('en-CA') === filterDate.value),
    ),
  )
  const legacyItems = computed(() =>
    records.value.filter(
      (r) =>
        !r.batchId &&
        (!filterKind.value || r.kind === filterKind.value) &&
        (!filterAccount.value || r.accountId === filterAccount.value) &&
        (!filterStatus.value || executionState(r) === filterStatus.value) &&
        (!filterVerdict.value || executionState(r) === 'completed' && verdict(r) === filterVerdict.value) &&
        (!filterDate.value ||
          new Date(r.startedAt).toLocaleDateString('en-CA') === filterDate.value),
    ),
  )
  async function fetchDetail(row: RecordEntry) {
    const stamp = `${row.updatedAt ?? row.startedAt}:${row.status}:${row.attempts?.length ?? 0}`
    const cached = details.get(row.id)
    if (cached && (cached as RecordEntry & { stamp?: string }).stamp === stamp)
      return { ...cached, progress: row.progress }
    const r = (row.task ? await api.task(row.id) : await api.detail(row.id)).record
    if (!r) throw Error('该记录已被清理')
    if (r.task) {
      r.samples = []
      for (const attempt of r.attempts ?? []) {
        let sample = sampleCache.get(attempt.key)
        if (!sample) {
          sample = (await api.sample(r.id, attempt.key)).sample
          sampleCache.set(attempt.key, sample)
        }
        r.samples.push(sample)
      }
    }
    Object.assign(r, { stamp })
    details.set(r.id, r)
    return r
  }
  async function loadResult() {
    const n = ++reportSequence
    if (!detailOpen.value) { reportLoading.value = false; return }
    const rows = [...currentRows.value]
    reportLoading.value = !resultRecords.value.length && !!rows.length
    try {
      const loaded = await Promise.all(rows.map(fetchDetail))
      if (!disposed && n === reportSequence) resultRecords.value = loaded
    } catch (e) {
      if (n === reportSequence) error.value = (e as Error).message
    } finally {
      if (n === reportSequence) reportLoading.value = false
    }
  }
  async function loadGallery() {
    if (currentBatch.value?.request.kind !== 'pelican' || batchAccounts.value.length < 2) {
      gallery.value = []
      return
    }
    const batch = currentBatch.value.request.id
    const rows = batchRows.value.filter((r) => r.status === 'completed')
    const loaded = await Promise.all(rows.map(fetchDetail))
    if (currentBatch.value?.request.id === batch) gallery.value = loaded
  }
  async function poll(schedule = true) {
    try {
      const [t, h, b] = await Promise.all([api.tasks(), api.history(), api.batches()])
      if (disposed) return
      records.value = [...t.records, ...h.records]
      batches.value = b.records
      if (loading.value || t.records.some(active)) concurrency.value = b.concurrency
      await Promise.all([loadResult(), loadGallery()])
      lastSyncedAt.value = Date.now()
      syncError.value = ''
    } catch (e) {
      syncError.value = (e as Error).message
    } finally {
      if (schedule && !disposed) {
        clearTimeout(timer)
        timer = setTimeout(() => void poll(), 1200)
      }
    }
  }
  async function loadModels() {
    const n = ++sequence
    const old = model.value
    models.value = []
    modelLoading.value = true
    try {
      if (keyId.value) {
        const result = await api.models(keyId.value)
        if (n === sequence) {
          models.value = result.models
          model.value = models.value.includes(old) ? old : ''
        }
      }
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      if (n === sequence) modelLoading.value = false
    }
  }
  watch(keyId, () => {
    if (!restoring) void loadModels()
  })
  async function refresh() {
    const wasRestoring = restoring
    loading.value = true
    error.value = ''
    try {
      if (workspaceConflict.value) {
        restoring = true
        await readWorkspace()
      }
      const snap = await api.snapshot()
      accounts.value = snap.accounts
      keys.value = snap.keys.filter((k) => k.enabled)
      if (!keys.value.some((k) => k.id === keyId.value))
        keyId.value = keys.value.length === 1 ? keys.value[0]!.id : ''
      selected.value = selected.value.filter((id) =>
        accounts.value.some((a) => a.account_id === id && a.enabled),
      )
      await loadModels()
      await poll()
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
      restoring = wasRestoring
    }
  }
  function chooseKind(next: string) {
    drafts[kind.value] = {
      effort: effort.value,
      profile: profile.value,
      repeats: repeats.value,
      outputVersion: outputVersion.value,
      batchId: currentBatchId.value,
      focus: focus.value,
    }
    kind.value = next
    const d = drafts[next]
    effort.value = d?.effort ?? ''
    profile.value = d?.profile ?? 'simple-v1'
    repeats.value = d?.repeats ?? 1
    outputVersion.value = d?.outputVersion ?? 'svg-v1'
    currentBatchId.value = d?.batchId ?? ''
    focus.value = d?.focus ?? ''
    detailOpen.value = false
    resultRecords.value = []
    persist()
    void loadResult()
  }
  async function sendPending() {
    if (!pending.value || busy.value) return
    busy.value = true
    error.value = ''
    try {
      await persist(true)
      const result = await api.batchSubmit(pending.value)
      currentBatchId.value = result.batch.request.id
      focus.value = result.batch.request.accountIds[0] ?? ''
      detailOpen.value = result.batch.request.accountIds.length === 1
      mobileAccounts.value = false
      historyId.value = ''
      legacyId.value = ''
      pending.value = null
      nav.value = 'test'
      persist()
      await poll(false)
      notice.value = '检测已提交，关闭页面后继续执行'
    } catch (e) {
      let rejected = false
      if (e instanceof ApiError && [400, 403, 409].includes(e.status)) {
        try {
          const b = await api.batches()
          rejected = !b.records.some((v) => v.request.id === pending.value?.id)
        } catch {
          /* Keep an unconfirmed submission. */
        }
      }
      if (rejected) {
        pending.value = null
        persist()
        error.value = (e as Error).message + '。本次未创建批次，可修改条件后重试。'
      } else error.value = (e as Error).message + '。未确认的提交已保留；重试复用原批次 ID。'
    } finally {
      busy.value = false
    }
  }
  async function start() {
    if (!ready.value) return
    pending.value = {
      id: crypto.randomUUID(),
      accountIds: [...selected.value],
      clientKeyId: keyId.value,
      model: model.value,
      effort: effort.value,
      kind: kind.value,
      profile: profile.value,
      repeats: kind.value === 'candy' ? repeats.value : 1,
      concurrency: concurrency.value,
      outputVersion: outputVersion.value,
    }
    await sendPending()
  }
  async function action(name: 'resume' | 'stop', r: RecordEntry) {
    busy.value = true
    error.value = ''
    try {
      if (name === 'stop' && r.batchId) await api.accountStop(r.batchId, r.accountId)
      else await api.action(name, r.id)
      await poll(false)
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      busy.value = false
    }
  }
  async function stopBatch() {
    if (!currentBatch.value) return
    busy.value = true
    try {
      await api.batchStop(currentBatch.value.request.id)
      await poll(false)
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      busy.value = false
    }
  }
  function openBatch(b: Batch, account?: string) {
    historyListScroll = scrollY
    historyId.value = b.request.id
    legacyId.value = ''
    const singleAccount = b.request.accountIds.length === 1 ? b.request.accountIds[0] : undefined
    focus.value = account && b.request.accountIds.includes(account) ? account : singleAccount ?? ''
    detailOpen.value = !!focus.value
    resultRecords.value = []
    gallery.value = []
    void loadResult()
  }
  function openLegacy(r: RecordEntry) {
    historyListScroll = scrollY
    historyId.value = ''
    legacyId.value = r.id
    focus.value = r.accountId
    detailOpen.value = true
    resultRecords.value = []
    void loadResult()
  }
  function focusAccount(id: string) {
    focus.value = id
    detailOpen.value = true
    resultRecords.value = []
    if (nav.value === 'test') persist()
    void loadResult()
  }
  function toggleFiltered(all: boolean) {
    const ids = filteredAccounts.value.filter((a) => a.enabled).map((a) => a.account_id)
    selected.value = all
      ? [...new Set([...selected.value, ...ids])]
      : selected.value.filter((id) => !ids.includes(id))
  }
  function compare(r: RecordEntry) {
    if (comparison.value.some((v) => v.id === r.id)) return
    if (comparison.value.length === 2) comparisonCandidate.value = r
    else comparison.value.push(r)
  }
  function replaceComparison(index: number) {
    if (comparisonCandidate.value && [0, 1].includes(index)) {
      comparison.value.splice(index, 1, comparisonCandidate.value)
      comparisonCandidate.value = null
    }
  }
  function closeHistory() {
    historyId.value = ''
    legacyId.value = ''
    detailOpen.value = false
    resultRecords.value = []
    void nextTick().then(() => window.scrollTo(0, historyListScroll))
  }
  watch(
    [model, keyId, selected, effort, profile, repeats, outputVersion],
    () => {
      if (!restoring)
        try {
          persist()
        } catch (e) {
          error.value = (e as Error).message
        }
    },
    { deep: true },
  )
  watch(accountSearch, () => (accountPage.value = 0))
  watch(nav, (next) => {
    if (next === 'history') {
      testFocus = focus.value
      testDetailOpen = detailOpen.value
      testScroll = scrollY
      historyId.value = ''
      legacyId.value = ''
      detailOpen.value = false
    } else {
      historyScroll = scrollY
      focus.value = testFocus
      detailOpen.value = testDetailOpen
    }
    resultRecords.value = []
    void Promise.all([loadResult(), loadGallery()]).then(async () => {
      await nextTick()
      window.scrollTo(0, next === 'test' ? testScroll : historyScroll)
    })
  })
  onMounted(async () => {
    if (!isPreview) {
      try {
        await readWorkspace()
      } catch (e) {
        workspaceConflict.value = true
        error.value = '无法读取页面草稿：' + (e as Error).message
      }
      await refresh()
    }
    restoring = false
  })
  const ticker = setInterval(() => (clock.value = Date.now()), 1000)
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(timer)
    clearInterval(ticker)
  })
  return {
    nav,
    kind,
    model,
    keyId,
    effort,
    profile,
    repeats,
    outputVersion,
    concurrency,
    accounts,
    keys,
    models,
    records,
    batches,
    selected,
    focus,
    currentBatchId,
    historyId,
    legacyId,
    error,
    notice,
    busy,
    loading,
    modelLoading,
    reportLoading,
    pending,
    accountSearch,
    accountPage,
    mobileAccounts,
    resultRecords,
    filterKind,
    filterAccount,
    filterStatus,
    filterDate,
    clock,
    comparison,
    gallery,
    comparisonCandidate,
    replaceComparison,
    readinessReason,
    syncError,
    lastSyncedAt,
    globalRunning,
    historyDetail,
    detailOpen,
    closeHistory,
    filterVerdict,
    batchState,
    currentBatch,
    batchRows,
    batchAccounts,
    currentRows,
    completedAccounts,
    waitingAccounts,
    accountLabel,
    batchAccountLabel,
    recordLabel,
    pageAccounts,
    filteredAccounts,
    planned,
    ready,
    running,
    batchStatus,
    accountStatus,
    historyItems,
    legacyItems,
    refresh,
    chooseKind,
    sendPending,
    start,
    action,
    stopBatch,
    openBatch,
    openLegacy,
    focusAccount,
    toggleFiltered,
    compare,
  }
}
export type Workspace = UnwrapNestedRefs<ReturnType<typeof workspace>>
