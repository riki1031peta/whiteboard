
<script setup lang="ts">
type Point = { x: number; y: number }

type Stroke = {
  id: string
  points: number[]
  color: string
  width: number
}

const boardRef = ref<HTMLElement | null>(null)

const strokes = ref<Stroke[]>([])
const history = ref<Stroke[][]>([])
const future = ref<Stroke[][]>([])

const color = ref('#2563eb')
const penWidth = ref(4)

const size = reactive({ width: 0, height: 0 })
const view = reactive({ x: 0, y: 0, scale: 1 })

const pointers = new Map<number, Point>()

let activePointerId: number | null = null
let activeStrokeId: string | null = null
let gesture: {
  distance: number
  scale: number
  world: Point
} | null = null

let resizeObserver: ResizeObserver | null = null

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

function cloneStrokes(): Stroke[] {
  return strokes.value.map(stroke => ({
    ...stroke,
    points: [...stroke.points],
  }))
}

function saveHistory() {
  history.value.push(cloneStrokes())

  if (history.value.length > 30) {
    history.value.shift()
  }

  future.value = []
}

function undo() {
  if (!history.value.length) return

  future.value.push(cloneStrokes())
  strokes.value = history.value.pop()!
}

function redo() {
  if (!future.value.length) return

  history.value.push(cloneStrokes())
  strokes.value = future.value.pop()!
}

function startStroke(point: Point, pointerId: number) {
  saveHistory()

  const world = toWorld(point)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`

  strokes.value.push({
    id,
    points: [world.x, world.y],
    color: color.value,
    width: penWidth.value,
  })

  activePointerId = pointerId
  activeStrokeId = id
}

function moveStroke(point: Point) {
  if (!activeStrokeId) return

  const stroke = strokes.value.find(
    item => item.id === activeStrokeId
  )

  if (!stroke) return

  const world = toWorld(point)

  // 新しい配列にして描画更新を確実に反映
  stroke.points = [
    ...stroke.points,
    world.x,
    world.y,
  ]
}

function stopStroke() {
  activePointerId = null
  activeStrokeId = null
}

function getGesturePoints(): [Point, Point] | null {
  if (pointers.size !== 2) return null

  const values = [...pointers.values()]
  return [values[0]!, values[1]!]
}

function beginGesture() {
  const points = getGesturePoints()
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

  const points = getGesturePoints()
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

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) {
    return
  }

  const point = localPoint(event)

  pointers.set(event.pointerId, point)
  boardRef.value?.setPointerCapture(event.pointerId)

  if (pointers.size === 1) {
    startStroke(point, event.pointerId)
  } else if (pointers.size === 2) {
    // 2本指になったら描画を終了
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

  // 2本指操作後、残った1本指で
  // 意図せず描画を再開しない
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
})
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
      :config="{
        width: size.width,
        height: size.height,
      }"
    >
      <v-layer :config="layerConfig">
        <v-line
          v-for="stroke in strokes"
          :key="stroke.id"
          :config="{
            points: stroke.points,
            stroke: stroke.color,
            strokeWidth: stroke.width,
            lineCap: 'round',
            lineJoin: 'round',
            listening: false,
          }"
        />
      </v-layer>
    </v-stage>

    <div class="topbar">
      <button @click="undo">↶</button>
      <button @click="redo">↷</button>
      <span>{{ Math.round(view.scale * 100) }}%</span>
    </div>

    <div class="toolbar">
      <label>
        色
        <input v-model="color" type="color" />
      </label>

      <label>
        太さ
        <input
          v-model.number="penWidth"
          type="range"
          min="1"
          max="20"
        />
      </label>
    </div>
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

.topbar {
  position: absolute;
  top: calc(12px + env(safe-area-inset-top));
  right: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 2px 12px #0002;
}

.topbar button {
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: #e2e8f0;
}

.toolbar {
  position: absolute;
  bottom: calc(20px + env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 16px;
  padding: 12px;
  background: white;
  border-radius: 14px;
  box-shadow: 0 4px 20px #0002;
}

.toolbar label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
</style>
