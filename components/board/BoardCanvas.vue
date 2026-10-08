
<script setup lang="ts">
import type Konva from 'konva'

type Tool = 'select' | 'pen' | 'eraser'
type Point = { x: number; y: number }

type BoardItem = {
  id: string
  type: 'pen' | 'text' | 'image'
  x: number
  y: number
  points?: number[]
  color?: string
  width?: number
  text?: string
  fontSize?: number
  imageUrl?: string
  image?: HTMLImageElement
  imageWidth?: number
  imageHeight?: number
  scaleX?: number
  scaleY?: number
}

const boardRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

const tool = ref<Tool>('pen')
const color = ref('#2563eb')
const penWidth = ref(4)

const items = ref<BoardItem[]>([])
const selectedId = ref<string | null>(null)

const history = ref<BoardItem[][]>([])
const future = ref<BoardItem[][]>([])

const size = reactive({ width: 0, height: 0 })
const view = reactive({ x: 0, y: 0, scale: 1 })

const pointers = new Map<number, Point>()
const stageRef = ref<{ getNode: () => Konva.Stage } | null>(null)
const transformerRef = ref<{
  getNode: () => Konva.Transformer
} | null>(null)

let activePointerId: number | null = null
let activeStrokeId: string | null = null
let resizeObserver: ResizeObserver | null = null

let gesture: {
  distance: number
  scale: number
  world: Point
} | null = null

// HTTPのローカルIPでも使えるID
function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const layerConfig = computed(() => ({
  x: view.x,
  y: view.y,
  scaleX: view.scale,
  scaleY: view.scale,
}))

function localPoint(event: PointerEvent): Point {
  const rect = boardRef.value!.getBoundingClientRect()

  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
}

function toWorld(point: Point): Point {
  return {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  }
}

function centerPoint(): Point {
  return toWorld({
    x: size.width / 2,
    y: size.height / 2,
  })
}

function cloneItems(): BoardItem[] {
  return items.value.map(item => ({
    ...item,
    points: item.points ? [...item.points] : undefined,
  }))
}

function saveHistory() {
  history.value.push(cloneItems())

  if (history.value.length > 30) {
    history.value.shift()
  }

  future.value = []
}

function undo() {
  if (!history.value.length) return

  future.value.push(cloneItems())
  items.value = history.value.pop()!
  selectedId.value = null
}

function redo() {
  if (!future.value.length) return

  history.value.push(cloneItems())
  items.value = future.value.pop()!
  selectedId.value = null
}

// ペン
function startStroke(point: Point, pointerId: number) {
  saveHistory()

  const world = toWorld(point)
  const id = createId()

  items.value.push({
    id,
    type: 'pen',
    x: 0,
    y: 0,
    points: [world.x, world.y],
    color: color.value,
    width: penWidth.value,
  })

  activePointerId = pointerId
  activeStrokeId = id
}

function moveStroke(point: Point) {
  if (!activeStrokeId) return

  const item = items.value.find(
    item => item.id === activeStrokeId
  )

  if (!item) return

  const world = toWorld(point)

  item.points = [
    ...(item.points ?? []),
    world.x,
    world.y,
  ]
}

function stopStroke() {
  activePointerId = null
  activeStrokeId = null
}

// 消しゴム（線を1本単位で削除）
function eraseItem(id: string) {
  if (tool.value !== 'eraser') return

  saveHistory()
  items.value = items.value.filter(item => item.id !== id)
  selectedId.value = null
}

function eraseAtPoint(point: Point) {
  const stage = stageRef.value?.getNode()
  if (!stage) return

  // 画面上の座標からKonvaのオブジェクトを探す
  const shape = stage.getIntersection(point)
  if (!shape) return

  const id = shape.id()
  if (!id) return

  eraseItem(id)
}

// テキスト
function addText() {
  const value = window.prompt('追加する文字を入力')
  if (!value) return

  saveHistory()

  const point = centerPoint()

  items.value.push({
    id: createId(),
    type: 'text',
    x: point.x,
    y: point.y,
    text: value,
    fontSize: 24,
    color: '#222222',
  })

  tool.value = 'select'
}

function editText(item: BoardItem) {
  if (tool.value !== 'select') return

  const value = window.prompt('文字を編集', item.text)
  if (value === null || value === item.text) return

  saveHistory()
  item.text = value
}

// 画像
function openFilePicker() {
  fileInputRef.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const url = URL.createObjectURL(file)
  const image = new Image()

  image.onload = () => {
    const point = centerPoint()
    const ratio = Math.min(1, 250 / image.width)

    saveHistory()

    items.value.push({
      id: createId(),
      type: 'image',
      x: point.x,
      y: point.y,
      image,
      imageUrl: url,
      imageWidth: image.width * ratio,
      imageHeight: image.height * ratio,
    })

    tool.value = 'select'
    input.value = ''
  }

  image.onerror = () => {
    URL.revokeObjectURL(url)
    input.value = ''
    alert('画像を読み込めませんでした')
  }

  image.src = url
}

// 選択
function selectItem(id: string) {
  if (tool.value === 'eraser') {
    eraseItem(id)
    return
  }

  if (tool.value === 'select') {
    selectedId.value = id
  }
}

function onItemDragStart() {
  saveHistory()
}

function onItemDragEnd(event: any, item: BoardItem) {
  item.x = event.target.x()
  item.y = event.target.y()
}

// 2本指操作
function gesturePoints(): [Point, Point] | null {
  if (pointers.size !== 2) return null

  const values = [...pointers.values()]
  return [values[0]!, values[1]!]
}

function beginGesture() {
  const points = gesturePoints()
  if (!points) return

  const [a, b] = points
  const center = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }

  gesture = {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    scale: view.scale,
    world: toWorld(center),
  }
}

function updateGesture() {
  if (!gesture) return

  const points = gesturePoints()
  if (!points) return

  const [a, b] = points
  const center = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }

  const distance = Math.hypot(a.x - b.x, a.y - b.y)

  const scale = Math.max(
    0.2,
    Math.min(
      5,
      gesture.scale *
        distance /
        Math.max(1, gesture.distance)
    )
  )

  view.scale = scale
  view.x = center.x - gesture.world.x * scale
  view.y = center.y - gesture.world.y * scale
}

// Pointer Events
function onPointerDown(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('.controls')) {
    return
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    return
  }

  const point = localPoint(event)

  pointers.set(event.pointerId, point)
  boardRef.value?.setPointerCapture(event.pointerId)

  if (pointers.size === 1) {
    if (tool.value === 'pen') {
      startStroke(point, event.pointerId)
    }

    if (tool.value === 'eraser') {
      eraseAtPoint(point)
    }
  }

  if (pointers.size === 2) {
    stopStroke()
    beginGesture()
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return

  const point = localPoint(event)
  pointers.set(event.pointerId, point)

  if (pointers.size === 2) {
    updateGesture()
  } else if (
    pointers.size === 1 &&
    activePointerId === event.pointerId
  ) {
    moveStroke(point)
  }
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId)

  if (activePointerId === event.pointerId) {
    stopStroke()
  }

  if (pointers.size < 2) {
    gesture = null
  }
}

function changeTool(next: Tool) {
  tool.value = next
  selectedId.value = null
}

function onTransformStart() {
  saveHistory()
}

function onTransformEnd(event: any, item: BoardItem) {
  const node = event.target

  item.x = node.x()
  item.y = node.y()
  item.scaleX = node.scaleX()
  item.scaleY = node.scaleY()
}

function deleteSelected() {
  if (!selectedId.value) return

  saveHistory()

  items.value = items.value.filter(
    item => item.id !== selectedId.value
  )

  selectedId.value = null
}

onMounted(() => {
  if (!boardRef.value) return

  resizeObserver = new ResizeObserver(([entry]) => {
    size.width = entry.contentRect.width
    size.height = entry.contentRect.height
  })

  resizeObserver.observe(boardRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()

  items.value.forEach(item => {
    if (item.imageUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(item.imageUrl)
    }
  })
})

watch([selectedId, tool, items], async () => {
  await nextTick()

  const transformer = transformerRef.value?.getNode()
  const stage = stageRef.value?.getNode()

  if (!transformer || !stage) return

  if (tool.value !== 'select' || !selectedId.value) {
    transformer.nodes([])
    return
  }

  const node = stage.findOne(
    `#${selectedId.value}`
  )

  transformer.nodes(node ? [node] : [])
  transformer.getLayer()?.batchDraw()
}, { flush: 'post' })
</script>

<template>
  <div
    ref="boardRef"
    class="board"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <v-stage
    ref="stageRef"
    :config="{
        width: size.width,
        height: size.height,
    }"
    >
      <v-layer :config="layerConfig"> 
        <v-transformer
            ref="transformerRef"
            :config="{
                rotateEnabled: false,
                flipEnabled: false,
                keepRatio: true,
                enabledAnchors: [
                'top-left',
                'top-right',
                'bottom-left',
                'bottom-right',
                ],
                borderStroke: '#2563eb',
                anchorStroke: '#2563eb',
                anchorFill: '#ffffff',
                anchorSize: 12,
            }"
        />
        <template v-for="item in items" :key="item.id">
            <v-line
            v-if="item.type === 'pen'"
            :config="{
                id: item.id,
                points: item.points,
                stroke: item.color,
                strokeWidth: item.width,
                lineCap: 'round',
                lineJoin: 'round',
                hitStrokeWidth: 25,
                listening: tool === 'eraser',
            }"
            />

          <v-text
            v-else-if="item.type === 'text'"
            :config="{
              id: item.id,
              x: item.x,
              y: item.y,
              text: item.text,
              fontSize: item.fontSize,
              fill: item.color,
              draggable: tool === 'select',
              listening: tool !== 'pen',
              scaleX: item.scaleX ?? 1,
              scaleY: item.scaleY ?? 1,
            }"
            @click="selectItem(item.id)"
            @tap="selectItem(item.id)"
            @dblclick="editText(item)"
            @dbltap="editText(item)"
            @dragstart="onItemDragStart"
            @dragend="onItemDragEnd($event, item)"
            @transformstart="onTransformStart"
            @transformend="onTransformEnd($event, item)"
          />

          <v-image
            v-else-if="item.type === 'image'"
            :config="{
              id: item.id,
              x: item.x,
              y: item.y,
              image: item.image,
              width: item.imageWidth,
              height: item.imageHeight,
              draggable: tool === 'select',
              listening: tool !== 'pen',
              scaleX: item.scaleX ?? 1,
              scaleY: item.scaleY ?? 1,
            }"
            @click="selectItem(item.id)"
            @tap="selectItem(item.id)"
            @dragstart="onItemDragStart"
            @dragend="onItemDragEnd($event, item)"
            @transformstart="onTransformStart"
            @transformend="onTransformEnd($event, item)"
          />
        </template>
      </v-layer>
    </v-stage>

    <div class="controls topbar">
      <button @click="undo">↶</button>
      <button @click="redo">↷</button>
      <span>{{ Math.round(view.scale * 100) }}%</span>
      <button
        v-if="selectedId && tool === 'select'"
        class="delete-button"
        @click="deleteSelected"
      >
        削除
</button>
    </div>

    <div v-if="tool === 'pen'" class="controls pen-options">
      <input v-model="color" type="color" />

      <input
        v-model.number="penWidth"
        type="range"
        min="1"
        max="20"
      />
    </div>

    <div class="controls toolbar">
      <button
        :class="{ active: tool === 'select' }"
        @click="changeTool('select')"
      >
        選択
      </button>

      <button
        :class="{ active: tool === 'pen' }"
        @click="changeTool('pen')"
      >
        ペン
      </button>

      <button
        :class="{ active: tool === 'eraser' }"
        @click="changeTool('eraser')"
      >
        消す
      </button>

      <button @click="addText">文字</button>
      <button @click="openFilePicker">画像</button>
    </div>

    <input
      ref="fileInputRef"
      type="file"
      accept="image/*"
      hidden
      @change="onFileChange"
    />
  </div>
</template>

<style scoped>
.board {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  background: #f8fafc;
  touch-action: none;
  overscroll-behavior: none;
}

.controls {
  position: absolute;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 2px 12px #0002;
  touch-action: manipulation;
}

.topbar {
  top: calc(12px + env(safe-area-inset-top));
  right: 12px;
}

.topbar button {
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: #e2e8f0;
}

.pen-options {
  bottom: calc(90px + env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
}

.toolbar {
  bottom: calc(20px + env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  gap: 5px;
}

.toolbar button {
  padding: 12px 10px;
  border: none;
  border-radius: 9px;
  background: #f1f5f9;
  color: #222;
  font-size: 13px;
  white-space: nowrap;
}

.toolbar button.active {
  background: #2563eb;
  color: white;
}

.delete-button {
  background: #fee2e2 !important;
  color: #dc2626;
}
</style>
