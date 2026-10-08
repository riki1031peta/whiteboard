export type SavedBoardItem = {
  id: string
  type: 'pen' | 'text' | 'image'
  x: number
  y: number
  points?: number[]
  color?: string
  width?: number
  text?: string
  fontSize?: number
  scaleX?: number
  scaleY?: number
  imageUrl?: string
  imageWidth?: number
  imageHeight?: number
}