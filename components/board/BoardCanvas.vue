<script setup lang="ts">
import type Konva from 'konva'
import type { SavedBoardItem } from '~/types/board'

const { $supabase } = useNuxtApp()
const route = useRoute()
const router = useRouter()

type Tool = 'select' | 'pen' | 'eraser'
type Point = { x: number; y: number }
type BoardItem = SavedBoardItem & { image?: HTMLImageElement }

const boardRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const stageRef = ref<{ getNode: () => Konva.Stage } | null>(null)
const transformerRef = ref<{ getNode: () => Konva.Transformer } | null>(null)
const tool = ref<Tool>('pen')
const color = ref('#2563eb')
const penWidth = ref(4)
const items = ref<BoardItem[]>([])
const selectedId = ref<string | null>(null)
const history = ref<BoardItem[][]>([])
const future = ref<BoardItem[][]>([])
const size = reactive({ width: 0, height: 0 })
const view = reactive({ x: 0, y: 0, scale: 1 })
const boardId = ref<string | null>(null)
const shareToken = ref<string | null>(null)
const saving = ref(false)
const sharing = ref(false)
const saveMessage = ref('')
const shareUrl = ref('')
const ready = ref(false)
const pointers = new Map<number, Point>()
let activePointerId: number | null = null
let activeStrokeId: string | null = null
let resizeObserver: ResizeObserver | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let channel: ReturnType<typeof $supabase.channel> | null = null
let gesture: { distance: number; scale: number; world: Point } | null = null
let refreshInFlight = false
let refreshPending = false
let destroyed = false
let syncChain: Promise<void> = Promise.resolve()
let lastSyncError: unknown = null
const dirtyIds = new Set<string>()
const deletedIds = new Set<string>()
const imageCache = new Map<string, HTMLImageElement>()
const layerConfig = computed(() => ({ x: view.x, y: view.y, scaleX: view.scale, scaleY: view.scale }))
const isShareRoute = computed(() => typeof route.params.token === 'string')
const failedImagePaths = new Set<string>()

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
function localPoint(event: PointerEvent): Point {
  const rect = boardRef.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
function toWorld(point: Point): Point {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}
function centerPoint(): Point {
  return toWorld({ x: size.width / 2, y: size.height / 2 })
}
function cloneItems(): BoardItem[] {
  return items.value.map(item => ({ ...item, points: item.points ? [...item.points] : undefined }))
}
function saveHistory() {
  history.value.push(cloneItems())
  if (history.value.length > 30) history.value.shift()
  future.value = []
}
function serializeItem(item: BoardItem): SavedBoardItem {
  return {
    id: item.id, type: item.type, x: item.x, y: item.y,
    points: item.points ? [...item.points] : undefined,
    color: item.color, width: item.width, text: item.text,
    fontSize: item.fontSize, imageUrl: item.imageUrl,
    imageWidth: item.imageWidth, imageHeight: item.imageHeight,
    scaleX: item.scaleX, scaleY: item.scaleY,
  }
}
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('画像の読み込みに失敗しました'))
    image.src = url
  })
}
async function hydrateItem(
  saved: SavedBoardItem
): Promise<BoardItem> {
  if (saved.type !== 'image' || !saved.imageUrl) {
    return { ...saved }
  }

  const path = saved.imageUrl

  const cached = imageCache.get(path)

  if (cached) {
    return { ...saved, image: cached }
  }

  // 以前読み込みに失敗した画像は繰り返し取得しない
  if (failedImagePaths.has(path)) {
    return { ...saved }
  }

  try {
    const { data, error } = await $supabase.storage
      .from('board-images')
      .createSignedUrl(path, 3600)

    if (error) throw error

    const image = await loadImage(data.signedUrl)

    imageCache.set(path, image)

    return { ...saved, image }
  } catch (error) {
    failedImagePaths.add(path)

    console.error('画像読み込みエラー:', {
      path,
      error,
    })

    return { ...saved }
  }
}
async function ensureUser() {
  const { data } = await $supabase.auth.getSession()
  if (data.session?.user) return data.session.user
  const result = await $supabase.auth.signInAnonymously()
  if (result.error || !result.data.user) throw result.error ?? new Error('匿名認証に失敗しました')
  return result.data.user
}

// 共有元・共有先の両方が同じRPCとboard_itemsを使用する。
async function fetchSnapshot() {
  if (!shareToken.value) throw new Error('共有トークンがありません')
  const { data, error } = await $supabase.rpc('collab_get_board', { p_token: shareToken.value })
  if (error) throw error
  if (!data) throw new Error('共有が停止されたか、ボードが見つかりません')
  return data as { id: string; title?: string; items: SavedBoardItem[] }
}
async function refreshBoard() {
  if (!ready.value || !shareToken.value || destroyed) return
  if (refreshInFlight) { refreshPending = true; return }
  if (activePointerId !== null || gesture || dirtyIds.size || deletedIds.size) {
    refreshPending = true
    return
  }
  refreshInFlight = true
  try {
    const data = await fetchSnapshot()
    if (activePointerId !== null || dirtyIds.size || deletedIds.size) {
      refreshPending = true
      return
    }
    const hydrated = await Promise.all((data.items ?? []).map(hydrateItem))
    if (activePointerId !== null || dirtyIds.size || deletedIds.size) {
      refreshPending = true
      return
    }
    items.value = hydrated
    if (selectedId.value && !hydrated.some(item => item.id === selectedId.value)) selectedId.value = null
  } catch (error) {
    console.error('リアルタイム同期エラー:', error)
    saveMessage.value = '同期に失敗しました。再接続を試みます'
  } finally {
    refreshInFlight = false
    if (refreshPending && !dirtyIds.size && !deletedIds.size && activePointerId === null && !gesture) {
      refreshPending = false
      void refreshBoard()
    }
  }
}
function notifyOthers() {
  if (!channel) return
  void channel.send({ type: 'broadcast', event: 'changed', payload: {} }).catch(console.error)
}
function queueOperation(id: string, action: () => Promise<void>, deleting = false) {
  if (!ready.value || !shareToken.value) return
  if (deleting) deletedIds.add(id)
  else dirtyIds.add(id)
  syncChain = syncChain.catch(() => {}).then(async () => {
    try {
      await action()
      lastSyncError = null
      notifyOthers()
    } catch (error) {
      console.error('共同編集の保存エラー:', error)
      lastSyncError = error
      saveMessage.value = '保存に失敗しました。通信と権限を確認してください'
      throw error
    } finally {
      if (deleting) deletedIds.delete(id)
      else dirtyIds.delete(id)
      if (refreshPending && !dirtyIds.size && !deletedIds.size) {
        refreshPending = false
        void refreshBoard()
      }
    }
  })
}
function syncItem(item: BoardItem) {
  if (!shareToken.value || !ready.value) return
  const snapshot = serializeItem(item)
  const token = shareToken.value
  queueOperation(item.id, async () => {
    const { error } = await $supabase.rpc('collab_save_item', { p_token: token, p_item: snapshot })
    if (error) throw error
  })
}
function syncDeletion(id: string) {
  if (!shareToken.value || !ready.value) return
  const token = shareToken.value
  queueOperation(id, async () => {
    const { error } = await $supabase.rpc('collab_delete_item', { p_token: token, p_item_id: id })
    if (error) throw error
  }, true)
}
function syncDiff(before: BoardItem[], after: BoardItem[]) {
  const previous = new Map(before.map(item => [item.id, item]))
  const current = new Map(after.map(item => [item.id, item]))
  for (const oldItem of before) if (!current.has(oldItem.id)) syncDeletion(oldItem.id)
  for (const item of after) {
    const oldItem = previous.get(item.id)
    if (!oldItem || JSON.stringify(serializeItem(oldItem)) !== JSON.stringify(serializeItem(item))) syncItem(item)
  }
}
function undo() {
  if (!history.value.length || !ready.value) return
  const before = cloneItems()
  future.value.push(before)
  items.value = history.value.pop()!
  selectedId.value = null
  syncDiff(before, items.value)
}
function redo() {
  if (!future.value.length || !ready.value) return
  const before = cloneItems()
  history.value.push(before)
  items.value = future.value.pop()!
  selectedId.value = null
  syncDiff(before, items.value)
}
async function connectRealtime() {
  if (!shareToken.value) return
  if (channel) await $supabase.removeChannel(channel)
  channel = $supabase.channel(`board:${shareToken.value}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'changed' }, () => { void refreshBoard() })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') void refreshBoard()
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') saveMessage.value = '通信が不安定です。再接続中...'
    })
  // 通知を取りこぼしても追いつくための定期的な再取得
  pollTimer = setInterval(() => { void refreshBoard() }, 3000)
}
async function initializeBoard() {
  try {
    const user = await ensureUser()
    const routeToken = typeof route.params.token === 'string' ? route.params.token : null
    if (routeToken) {
      shareToken.value = routeToken
      const data = await fetchSnapshot()
      boardId.value = data.id
      items.value = await Promise.all((data.items ?? []).map(hydrateItem))
    } else {
      const id = typeof route.params.id === 'string' ? route.params.id : localStorage.getItem('whiteboard-id')
      if (id) {
        const { data, error } = await $supabase.from('boards')
          .select('id, share_token, content').eq('id', id).eq('owner_id', user.id).single()
        if (error) throw error
        boardId.value = data.id
        if (data.share_token) {
          shareToken.value = data.share_token
          const snapshot = await fetchSnapshot()
          // 以前の保存方式から移行しきれていない場合だけ補完する
          if (!(snapshot.items ?? []).length && Array.isArray(data.content)) {
            for (const legacyItem of data.content as SavedBoardItem[]) {
              const { error: migrationError } = await $supabase.rpc('collab_save_item', {
                p_token: data.share_token, p_item: legacyItem,
              })
              if (migrationError) throw migrationError
            }
            snapshot.items = data.content as SavedBoardItem[]
          }
          items.value = await Promise.all((snapshot.items ?? []).map(hydrateItem))
          shareUrl.value = new URL(`/share/${data.share_token}`, window.location.origin).toString()
        } else {
          const legacy = Array.isArray(data.content) ? data.content as SavedBoardItem[] : []
          items.value = await Promise.all(legacy.map(hydrateItem))
        }
      }
    }
    ready.value = true
    saveMessage.value = '読み込み完了'
    if (shareToken.value) await connectRealtime()
  } catch (error) {
    console.error('ボード初期化エラー:', error)
    saveMessage.value = '読み込みに失敗しました'
  }
}
async function saveBoard() {
  if (saving.value || !ready.value) return
  saving.value = true
  saveMessage.value = '保存中...'
  try {
    if (shareToken.value) {
      // 変更は操作のたびに保存。全件上書きはしない。
      await syncChain
      if (lastSyncError) throw lastSyncError
      saveMessage.value = '保存済みです'
    } else {
      const user = await ensureUser()
      const content = items.value.map(serializeItem)
      if (!boardId.value) {
        const { data, error } = await $supabase.from('boards')
          .insert({ owner_id: user.id, content }).select('id').single()
        if (error) throw error
        boardId.value = data.id
        localStorage.setItem('whiteboard-id', data.id)
        await router.replace(`/board/${data.id}`)
      } else {
        const { error } = await $supabase.from('boards').update({ content, updated_at: new Date().toISOString() })
          .eq('id', boardId.value).eq('owner_id', user.id)
        if (error) throw error
      }
      saveMessage.value = '保存しました！'
    }
  } catch (error) {
    console.error('保存エラー:', error)
    saveMessage.value = '保存に失敗しました'
  } finally { saving.value = false }
}
async function shareBoard() {
  if (sharing.value || !ready.value) return
  if (!boardId.value) { saveMessage.value = '先に保存してください'; return }
  sharing.value = true
  try {
    await ensureUser()
    const { data: token, error } = await $supabase.rpc('enable_board_sharing', { p_board_id: boardId.value })
    if (error || !token) throw error ?? new Error('共有トークンを取得できません')
    shareToken.value = token
    // 共有前の内容がboard_itemsに移行されていない場合は差分を投入
    const snapshot = await fetchSnapshot()
    const existing = new Set((snapshot.items ?? []).map(item => item.id))
    for (const item of items.value) {
      if (existing.has(item.id)) continue
      const { error: saveError } = await $supabase.rpc('collab_save_item', { p_token: token, p_item: serializeItem(item) })
      if (saveError) throw saveError
    }
    const url = new URL(`/share/${token}`, window.location.origin).toString()
    shareUrl.value = url
    if (!channel) await connectRealtime()
    try {
      await navigator.clipboard.writeText(url)
      saveMessage.value = '共有URLをコピーしました！'
    } catch {
      saveMessage.value = '共有URLを作成しました。表示欄からコピーしてください'
    }
  } catch (error) {
    console.error('共有エラー:', error)
    saveMessage.value = '共有に失敗しました'
  } finally { sharing.value = false }
}
async function stopSharing() {
  if (!boardId.value || isShareRoute.value) return
  try {
    await syncChain
    // 共有解除後も作成者が編集を続けられるよう現時点の状態をcontentへ保存
    const user = await ensureUser()
    const { error: updateError } = await $supabase.from('boards')
      .update({ content: items.value.map(serializeItem) })
      .eq('id', boardId.value).eq('owner_id', user.id)
    if (updateError) throw updateError
    const { error } = await $supabase.rpc('disable_board_sharing', { p_board_id: boardId.value })
    if (error) throw error
    if (channel) { await $supabase.removeChannel(channel); channel = null }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    shareToken.value = null
    shareUrl.value = ''
    saveMessage.value = '共有を停止しました'
  } catch (error) {
    console.error('共有停止エラー:', error)
    saveMessage.value = '共有停止に失敗しました'
  }
}
function startStroke(point: Point, pointerId: number) {
  saveHistory()
  const world = toWorld(point)
  const id = createId()
  items.value.push({ id, type: 'pen', x: 0, y: 0, points: [world.x, world.y], color: color.value, width: penWidth.value })
  activePointerId = pointerId
  activeStrokeId = id
}
function moveStroke(point: Point) {
  if (!activeStrokeId) return
  const item = items.value.find(item => item.id === activeStrokeId)
  if (!item) return
  const world = toWorld(point)
  item.points = [...(item.points ?? []), world.x, world.y]
}
function stopStroke() {
  const item = items.value.find(item => item.id === activeStrokeId)
  activePointerId = null
  activeStrokeId = null
  if (item) syncItem(item)
  if (refreshPending) void refreshBoard()
}
function eraseItem(id: string) {
  if (tool.value !== 'eraser' || !items.value.some(item => item.id === id)) return
  saveHistory()
  items.value = items.value.filter(item => item.id !== id)
  selectedId.value = null
  syncDeletion(id)
}
function eraseAtPoint(point: Point) {
  const shape = stageRef.value?.getNode().getIntersection(point)
  const id = shape?.id()
  if (id) eraseItem(id)
}
function addText() {
  if (!ready.value) return
  const value = window.prompt('追加する文字を入力')
  if (!value) return
  saveHistory()
  const point = centerPoint()
  const item: BoardItem = { id: createId(), type: 'text', x: point.x, y: point.y, text: value, fontSize: 24, color: '#222222' }
  items.value.push(item)
  tool.value = 'select'
  syncItem(item)
}
function editText(item: BoardItem) {
  if (tool.value !== 'select' || !ready.value) return
  const value = window.prompt('文字を編集', item.text)
  if (value === null || value === item.text) return
  saveHistory()
  item.text = value
  syncItem(item)
}
function openFilePicker() { if (ready.value) fileInputRef.value?.click() }
async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !ready.value) return
  if (!file.type.startsWith('image/')) { alert('画像を選択してください'); return }
  if (file.size > 10 * 1024 * 1024) { alert('画像は10MB以下にしてください'); return }
  saveMessage.value = '画像をアップロード中...'
  try {
    const user = await ensureUser()
    const extension = file.name.split('.').pop()?.toLowerCase() || 'png'
    const path = `${user.id}/${createId()}.${extension}`
    const { error: uploadError } = await $supabase.storage.from('board-images')
      .upload(path, file, { contentType: file.type, upsert: false })
    if (uploadError) throw uploadError
    const { data, error } = await $supabase.storage.from('board-images').createSignedUrl(path, 3600)
    if (error) throw error
    const image = await loadImage(data.signedUrl)
    imageCache.set(path, image)
    const point = centerPoint()
    const ratio = Math.min(1, 250 / image.width)
    const item: BoardItem = {
      id: createId(), type: 'image', x: point.x, y: point.y, image, imageUrl: path,
      imageWidth: image.width * ratio, imageHeight: image.height * ratio,
    }
    saveHistory()
    items.value.push(item)
    tool.value = 'select'
    syncItem(item)
    saveMessage.value = '画像を追加しました'
  } catch (error) {
    console.error('画像アップロードエラー:', error)
    saveMessage.value = '画像のアップロードに失敗しました'
  }
}
function selectItem(id: string) {
  if (tool.value === 'eraser') { eraseItem(id); return }
  if (tool.value === 'select') selectedId.value = id
}
function onItemDragStart() { saveHistory() }
function onItemDragEnd(event: { target: Konva.Node }, item: BoardItem) {
  item.x = event.target.x()
  item.y = event.target.y()
  syncItem(item)
}
function onTransformStart() { saveHistory() }
function onTransformEnd(event: { target: Konva.Node }, item: BoardItem) {
  const node = event.target
  item.x = node.x()
  item.y = node.y()
  item.scaleX = node.scaleX()
  item.scaleY = node.scaleY()
  syncItem(item)
}
function deleteSelected() {
  const id = selectedId.value
  if (!id) return
  saveHistory()
  items.value = items.value.filter(item => item.id !== id)
  selectedId.value = null
  syncDeletion(id)
}
function gesturePoints(): [Point, Point] | null {
  if (pointers.size !== 2) return null
  const values = [...pointers.values()]
  return [values[0]!, values[1]!]
}
function beginGesture() {
  const points = gesturePoints()
  if (!points) return
  const [a, b] = points
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  gesture = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale, world: toWorld(center) }
}
function updateGesture() {
  if (!gesture) return
  const points = gesturePoints()
  if (!points) return
  const [a, b] = points
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const distance = Math.hypot(a.x - b.x, a.y - b.y)
  const scale = Math.max(0.2, Math.min(5, gesture.scale * distance / Math.max(1, gesture.distance)))
  view.scale = scale
  view.x = center.x - gesture.world.x * scale
  view.y = center.y - gesture.world.y * scale
}
function onPointerDown(event: PointerEvent) {
  if (!ready.value || (event.target as HTMLElement).closest('.controls')) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const point = localPoint(event)
  pointers.set(event.pointerId, point)
  boardRef.value?.setPointerCapture(event.pointerId)
  if (pointers.size === 1) {
    if (tool.value === 'pen') startStroke(point, event.pointerId)
    if (tool.value === 'eraser') eraseAtPoint(point)
  }
  if (pointers.size === 2) { stopStroke(); beginGesture() }
}
function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  const point = localPoint(event)
  pointers.set(event.pointerId, point)
  if (pointers.size === 2) updateGesture()
  else if (pointers.size === 1 && activePointerId === event.pointerId) moveStroke(point)
  else if (pointers.size === 1 && tool.value === 'eraser') eraseAtPoint(point)
}
function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId)
  if (activePointerId === event.pointerId) stopStroke()
  if (pointers.size < 2) gesture = null
  if (refreshPending) void refreshBoard()
}
function changeTool(next: Tool) { tool.value = next; selectedId.value = null }

function onWheel(event: WheelEvent) {
  event.preventDefault()

  const board = boardRef.value
  if (!board) return

  const rect = board.getBoundingClientRect()

  // カーソルの位置
  const pointer = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }

  // ズーム前のカーソル位置をワールド座標に変換
  const world = toWorld(pointer)

  // ホイールの移動量に応じて倍率を変更
  const zoomFactor = Math.exp(-event.deltaY * 0.005)

  const newScale = Math.max(
    0.2,
    Math.min(5, view.scale * zoomFactor)
  )

  view.scale = newScale

  // カーソル位置を中心に拡大・縮小
  view.x = pointer.x - world.x * newScale
  view.y = pointer.y - world.y * newScale
}

onMounted(() => {
  if (!boardRef.value) return
  resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return
    size.width = entry.contentRect.width
    size.height = entry.contentRect.height
  })
  resizeObserver.observe(boardRef.value)
  void initializeBoard()
})
onBeforeUnmount(() => {
  destroyed = true
  resizeObserver?.disconnect()
  if (pollTimer) clearInterval(pollTimer)
  if (channel) void $supabase.removeChannel(channel)
})
watch([selectedId, tool, items], async () => {
  await nextTick()
  const transformer = transformerRef.value?.getNode()
  const stage = stageRef.value?.getNode()
  if (!transformer || !stage) return
  if (tool.value !== 'select' || !selectedId.value) { transformer.nodes([]); return }
  const node = stage.findOne(`#${selectedId.value}`)
  transformer.nodes(node ? [node] : [])
  transformer.getLayer()?.batchDraw()
}, { flush: 'post' })
</script>

<template>
  <div ref="boardRef" class="board" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" @wheel.prevent="onWheel">
    <v-stage ref="stageRef" :config="{ width: size.width, height: size.height }">
      <v-layer :config="layerConfig">
        <v-transformer ref="transformerRef" :config="{
          rotateEnabled: false, flipEnabled: false, keepRatio: true,
          enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
          borderStroke: '#2563eb', anchorStroke: '#2563eb', anchorFill: '#ffffff', anchorSize: 12
        }" />
        <template v-for="item in items" :key="item.id">
          <v-line v-if="item.type === 'pen'" :config="{
            id: item.id, x: item.x, y: item.y, points: item.points ?? [],
            stroke: item.color, strokeWidth: item.width, lineCap: 'round', lineJoin: 'round',
            hitStrokeWidth: 25, listening: tool === 'eraser'
          }" />
          <v-text v-else-if="item.type === 'text'" :config="{
            id: item.id, x: item.x, y: item.y, text: item.text, fontSize: item.fontSize,
            fill: item.color, draggable: tool === 'select', listening: tool !== 'pen',
            scaleX: item.scaleX ?? 1, scaleY: item.scaleY ?? 1
          }" @click="selectItem(item.id)" @tap="selectItem(item.id)" @dblclick="editText(item)" @dbltap="editText(item)"
            @dragstart="onItemDragStart" @dragend="onItemDragEnd($event, item)"
            @transformstart="onTransformStart" @transformend="onTransformEnd($event, item)" />
          <v-image v-else-if="item.type === 'image'" :config="{
            id: item.id, x: item.x, y: item.y, image: item.image,
            width: item.imageWidth, height: item.imageHeight,
            draggable: tool === 'select', listening: tool !== 'pen',
            scaleX: item.scaleX ?? 1, scaleY: item.scaleY ?? 1
          }" @click="selectItem(item.id)" @tap="selectItem(item.id)"
            @dragstart="onItemDragStart" @dragend="onItemDragEnd($event, item)"
            @transformstart="onTransformStart" @transformend="onTransformEnd($event, item)" />
        </template>
      </v-layer>
    </v-stage>

    <div class="controls topbar">
      <button @click="router.push('/')">← 一覧</button>
      <button :disabled="!ready" @click="undo">↶</button>
      <button :disabled="!ready" @click="redo">↷</button>
      <span>{{ Math.round(view.scale * 100) }}%</span>
      <button v-if="selectedId && tool === 'select'" class="delete-button" @click="deleteSelected">削除</button>
      <button :disabled="saving || !ready" @click="saveBoard">{{ saving ? '保存中...' : '保存' }}</button>
      <button v-if="!isShareRoute" :disabled="sharing || !boardId || !ready" @click="shareBoard">{{ sharing ? '準備中...' : '共有' }}</button>
      <span v-if="saveMessage" class="save-message">{{ saveMessage }}</span>
    </div>
    <div v-if="shareUrl && !isShareRoute" class="controls share-panel">
      <input :value="shareUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
      <button @click="stopSharing">共有停止</button>
    </div>
    <div v-if="tool === 'pen'" class="controls pen-options">
      <input v-model="color" type="color" />
      <input v-model.number="penWidth" type="range" min="1" max="20" />
    </div>
    <div class="controls toolbar">
      <button :class="{ active: tool === 'select' }" @click="changeTool('select')">選択</button>
      <button :class="{ active: tool === 'pen' }" @click="changeTool('pen')">ペン</button>
      <button :class="{ active: tool === 'eraser' }" @click="changeTool('eraser')">消す</button>
      <button @click="addText">文字</button>
      <button @click="openFilePicker">画像</button>
    </div>
    <input ref="fileInputRef" type="file" accept="image/*" hidden @change="onFileChange" />
  </div>
</template>

<style scoped>
.board { position: fixed; inset: 0; width: 100%; height: 100dvh; overflow: hidden; background: #f8fafc; touch-action: none; overscroll-behavior: none; }
.controls { position: absolute; z-index: 10; display: flex; align-items: center; gap: 8px; padding: 10px; background: white; border-radius: 12px; box-shadow: 0 2px 12px #0002; touch-action: manipulation; }
.topbar { top: calc(12px + env(safe-area-inset-top)); right: 12px; max-width: calc(100vw - 24px); flex-wrap: wrap; justify-content: flex-end; }
.topbar button { padding: 8px 12px; border: none; border-radius: 8px; background: #e2e8f0; }
.topbar button:disabled { opacity: 0.5; }
.pen-options { bottom: calc(90px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); }
.toolbar { bottom: calc(20px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); gap: 5px; }
.toolbar button { padding: 12px 10px; border: none; border-radius: 9px; background: #f1f5f9; color: #222; font-size: 13px; white-space: nowrap; }
.toolbar button.active { background: #2563eb; color: white; }
.delete-button { background: #fee2e2 !important; color: #dc2626; }
.save-message { font-size: 12px; color: #2563eb; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.share-panel { top: calc(95px + env(safe-area-inset-top)); right: 12px; max-width: calc(100vw - 24px); }
.share-panel input { min-width: 0; width: 240px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 8px; }
.share-panel button { white-space: nowrap; padding: 8px 12px; border: none; border-radius: 8px; background: #fee2e2; color: #dc2626; }
</style>
