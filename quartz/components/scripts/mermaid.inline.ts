import { registerEscapeHandler, removeAllChildren } from "./util"

interface Position {
  x: number
  y: number
}

interface RGB {
  r: number
  g: number
  b: number
}

const DARK_SURFACE: RGB = { r: 15, g: 23, b: 42 }
const DARK_LABEL_SURFACE: RGB = { r: 20, g: 30, b: 48 }
const DARK_STROKE_TARGET: RGB = { r: 191, g: 219, b: 254 }
const DARK_TEXT = "#e5eefc"
const LIGHT_TEXT = "#172033"

class DiagramPanZoom {
  private isDragging = false
  private startPan: Position = { x: 0, y: 0 }
  private currentPan: Position = { x: 0, y: 0 }
  private scale = 1
  private readonly MIN_SCALE = 0.25
  private readonly MAX_SCALE = 4

  cleanups: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private content: HTMLElement,
  ) {
    this.setupEventListeners()
    this.setupNavigationControls()
    this.resetTransform()
  }

  private setupEventListeners() {
    // Mouse drag events
    const mouseDownHandler = this.onMouseDown.bind(this)
    const mouseMoveHandler = this.onMouseMove.bind(this)
    const mouseUpHandler = this.onMouseUp.bind(this)

    // Touch drag events
    const touchStartHandler = this.onTouchStart.bind(this)
    const touchMoveHandler = this.onTouchMove.bind(this)
    const touchEndHandler = this.onTouchEnd.bind(this)

    const resizeHandler = this.resetTransform.bind(this)

    this.container.addEventListener("mousedown", mouseDownHandler)
    document.addEventListener("mousemove", mouseMoveHandler)
    document.addEventListener("mouseup", mouseUpHandler)

    this.container.addEventListener("touchstart", touchStartHandler, { passive: false })
    document.addEventListener("touchmove", touchMoveHandler, { passive: false })
    document.addEventListener("touchend", touchEndHandler)

    window.addEventListener("resize", resizeHandler)

    this.cleanups.push(
      () => this.container.removeEventListener("mousedown", mouseDownHandler),
      () => document.removeEventListener("mousemove", mouseMoveHandler),
      () => document.removeEventListener("mouseup", mouseUpHandler),
      () => this.container.removeEventListener("touchstart", touchStartHandler),
      () => document.removeEventListener("touchmove", touchMoveHandler),
      () => document.removeEventListener("touchend", touchEndHandler),
      () => window.removeEventListener("resize", resizeHandler),
    )
  }

  cleanup() {
    for (const cleanup of this.cleanups) {
      cleanup()
    }
  }

  private setupNavigationControls() {
    const controls = document.createElement("div")
    controls.className = "mermaid-controls"

    // Zoom controls
    const zoomIn = this.createButton("+", () => this.zoom(0.1))
    const zoomOut = this.createButton("-", () => this.zoom(-0.1))
    const resetBtn = this.createButton("Reset", () => this.resetTransform())

    controls.appendChild(zoomOut)
    controls.appendChild(resetBtn)
    controls.appendChild(zoomIn)

    this.container.appendChild(controls)
  }

  private createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button")
    button.textContent = text
    button.className = "mermaid-control-button"
    button.addEventListener("click", onClick)
    window.addCleanup(() => button.removeEventListener("click", onClick))
    return button
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return // Only handle left click
    this.isDragging = true
    this.startPan = { x: e.clientX - this.currentPan.x, y: e.clientY - this.currentPan.y }
    this.container.style.cursor = "grabbing"
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isDragging) return
    e.preventDefault()

    this.currentPan = {
      x: e.clientX - this.startPan.x,
      y: e.clientY - this.startPan.y,
    }

    this.updateTransform()
  }

  private onMouseUp() {
    this.isDragging = false
    this.container.style.cursor = "grab"
  }

  private onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    this.isDragging = true
    const touch = e.touches[0]
    this.startPan = { x: touch.clientX - this.currentPan.x, y: touch.clientY - this.currentPan.y }
  }

  private onTouchMove(e: TouchEvent) {
    if (!this.isDragging || e.touches.length !== 1) return
    e.preventDefault() // Prevent scrolling

    const touch = e.touches[0]
    this.currentPan = {
      x: touch.clientX - this.startPan.x,
      y: touch.clientY - this.startPan.y,
    }

    this.updateTransform()
  }

  private onTouchEnd() {
    this.isDragging = false
  }

  private zoom(delta: number) {
    const newScale = Math.min(Math.max(this.scale + delta, this.MIN_SCALE), this.MAX_SCALE)

    // Zoom around center
    const rect = this.content.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const scaleDiff = newScale - this.scale
    this.currentPan.x -= centerX * scaleDiff
    this.currentPan.y -= centerY * scaleDiff

    this.scale = newScale
    this.updateTransform()
  }

  private updateTransform() {
    this.content.style.transform = `translate(${this.currentPan.x}px, ${this.currentPan.y}px) scale(${this.scale})`
  }

  private getDiagramSize(svg: SVGSVGElement) {
    const viewBox = svg.viewBox?.baseVal
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      return { width: viewBox.width, height: viewBox.height }
    }

    const bbox = svg.getBBox()
    return { width: bbox.width, height: bbox.height }
  }

  private resetTransform() {
    const svg = this.content.querySelector("svg")
    if (!svg) return

    const { width, height } = this.getDiagramSize(svg)
    const padding = 32
    const availableWidth = Math.max(this.container.clientWidth - padding * 2, 1)
    const availableHeight = Math.max(this.container.clientHeight - padding * 2, 1)
    const fitScale = Math.min(availableWidth / width, availableHeight / height, 1.4)

    this.content.style.width = `${width}px`
    this.content.style.height = `${height}px`
    this.scale = Math.min(Math.max(fitScale, this.MIN_SCALE), this.MAX_SCALE)
    this.currentPan = {
      x: (this.container.clientWidth - width * this.scale) / 2,
      y: (this.container.clientHeight - height * this.scale) / 2,
    }
    this.updateTransform()
  }
}

const cssVars = [
  "--secondary",
  "--tertiary",
  "--gray",
  "--light",
  "--lightgray",
  "--highlight",
  "--dark",
  "--darkgray",
  "--bodyFont",
  "--codeFont",
] as const

let mermaidImport = undefined

function parseColor(color: string): RGB | null {
  const value = color.trim()
  if (!value || value === "none" || value === "transparent") return null

  const hexMatch = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]
    if (hex.length === 3) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      }
    }

    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    }
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbMatch) {
    const [r, g, b] = rgbMatch[1]
      .split(",")
      .slice(0, 3)
      .map((part) => Number.parseFloat(part.trim()))

    if ([r, g, b].every((channel) => Number.isFinite(channel))) {
      return { r, g, b }
    }
  }

  return null
}

function mixColors(base: RGB, target: RGB, ratio: number): RGB {
  return {
    r: Math.round(base.r * (1 - ratio) + target.r * ratio),
    g: Math.round(base.g * (1 - ratio) + target.g * ratio),
    b: Math.round(base.b * (1 - ratio) + target.b * ratio),
  }
}

function toCssColor(color: RGB) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

function getDiagramType(source: string) {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("%%{"))

  return lines[0] ?? ""
}

function applyDarkFlowchartTheme(svg: SVGSVGElement) {
  const shapeSelector = [
    ".node rect",
    ".node circle",
    ".node ellipse",
    ".node polygon",
    ".node path",
    ".cluster rect",
    ".cluster polygon",
  ].join(", ")

  svg.querySelectorAll<SVGElement>(shapeSelector).forEach((shape) => {
    const computed = window.getComputedStyle(shape)
    const fill = parseColor(computed.fill)
    const stroke = parseColor(computed.stroke) ?? fill

    if (fill) {
      shape.style.fill = toCssColor(mixColors(fill, DARK_SURFACE, 0.7))
    }

    if (stroke) {
      shape.style.stroke = toCssColor(mixColors(stroke, DARK_STROKE_TARGET, 0.35))
      shape.style.strokeWidth = "1.6px"
    }
  })

  svg.querySelectorAll<SVGElement>(".edgeLabel rect, .labelBkg").forEach((label) => {
    label.style.fill = toCssColor(DARK_LABEL_SURFACE)
    label.style.stroke = "rgba(148, 163, 184, 0.65)"
  })

  svg
    .querySelectorAll<SVGElement>(".flowchart-link, .edgePath .path, .relation, .arrowheadPath")
    .forEach((line) => {
      line.style.stroke = "#94a3b8"
      line.style.strokeWidth = "2px"
    })

  svg.querySelectorAll<SVGElement>(".arrowheadPath").forEach((line) => {
    line.style.fill = "#94a3b8"
  })

  svg.querySelectorAll<SVGTextElement>("text").forEach((text) => {
    text.style.fill = DARK_TEXT
    text.style.opacity = "1"
  })

  svg
    .querySelectorAll<HTMLElement>("foreignObject div, foreignObject span, foreignObject p")
    .forEach((el) => {
      el.style.color = DARK_TEXT
      el.style.background = "transparent"
      el.style.opacity = "1"
    })
}

function applyDarkMindmapTheme(svg: SVGSVGElement) {
  svg.querySelectorAll<SVGTextElement>("text").forEach((text) => {
    text.style.fill = LIGHT_TEXT
    text.style.opacity = "1"
  })

  svg
    .querySelectorAll<HTMLElement>("foreignObject div, foreignObject span, foreignObject p")
    .forEach((el) => {
      el.style.color = LIGHT_TEXT
      el.style.background = "transparent"
      el.style.opacity = "1"
    })

  svg
    .querySelectorAll<SVGElement>(".mindmap-node rect, .mindmap-node circle, .mindmap-node path")
    .forEach((shape) => {
      const computed = window.getComputedStyle(shape)
      const stroke = parseColor(computed.stroke)

      if (stroke) {
        shape.style.stroke = toCssColor(mixColors(stroke, { r: 15, g: 23, b: 42 }, 0.2))
        shape.style.strokeWidth = "1.6px"
      }
    })
}

function applyDarkQuadrantTheme(svg: SVGSVGElement) {
  const rects = Array.from(svg.querySelectorAll<SVGRectElement>("rect"))
  const plotRect = rects.reduce<SVGRectElement | null>((largest, rect) => {
    const area = rect.width.baseVal.value * rect.height.baseVal.value
    const largestArea = largest ? largest.width.baseVal.value * largest.height.baseVal.value : -1
    return area > largestArea ? rect : largest
  }, null)

  const plotBounds = plotRect?.getBBox()

  svg.querySelectorAll<SVGElement>("circle").forEach((circle) => {
    circle.style.fill = "#1e293b"
    circle.style.stroke = "#e2e8f0"
    circle.style.strokeWidth = "2px"
  })

  svg.querySelectorAll<SVGElement>("line, path").forEach((shape) => {
    const computed = window.getComputedStyle(shape)
    if (computed.fill === "none") {
      shape.style.stroke = "#6b9fd4"
      shape.style.strokeWidth = "2px"
    }
  })

  svg.querySelectorAll<SVGTextElement>("text").forEach((text) => {
    const box = text.getBBox()
    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    const insidePlot =
      plotBounds &&
      centerX >= plotBounds.x &&
      centerX <= plotBounds.x + plotBounds.width &&
      centerY >= plotBounds.y &&
      centerY <= plotBounds.y + plotBounds.height

    text.style.fill = insidePlot ? LIGHT_TEXT : DARK_TEXT
    text.style.opacity = "1"
    text.style.fontWeight = insidePlot ? "700" : "800"

    if (!insidePlot) {
      text.style.fontSize = "20px"
    }
  })

  svg
    .querySelectorAll<HTMLElement>("foreignObject div, foreignObject span, foreignObject p")
    .forEach((el) => {
      el.style.opacity = "1"
      el.style.fontWeight = "700"
    })
}

function applyDarkTheme(svg: SVGSVGElement, diagramType: string) {
  if (diagramType.startsWith("mindmap")) {
    applyDarkMindmapTheme(svg)
    return
  }

  if (diagramType.startsWith("quadrantChart")) {
    applyDarkQuadrantTheme(svg)
    return
  }

  if (diagramType.startsWith("flowchart")) {
    applyDarkFlowchartTheme(svg)
    return
  }

  svg.querySelectorAll<SVGTextElement>("text").forEach((text) => {
    text.style.opacity = "1"
  })

  svg
    .querySelectorAll<HTMLElement>("foreignObject div, foreignObject span, foreignObject p")
    .forEach((el) => {
      el.style.opacity = "1"
    })
}

document.addEventListener("nav", async () => {
  const center = document.querySelector(".center") as HTMLElement
  const nodes = center.querySelectorAll("code.mermaid") as NodeListOf<HTMLElement>
  if (nodes.length === 0) return

  mermaidImport ||= await import(
    // @ts-ignore
    "https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.0/mermaid.esm.min.mjs"
  )
  const mermaid = mermaidImport.default

  const textMapping: WeakMap<HTMLElement, string> = new WeakMap()
  const typeMapping: WeakMap<HTMLElement, string> = new WeakMap()
  for (const node of nodes) {
    const source = node.innerText
    textMapping.set(node, source)
    const diagramType = getDiagramType(source)
    typeMapping.set(node, diagramType)
    node.dataset.mermaidType = diagramType
    node.parentElement?.setAttribute("data-mermaid-type", diagramType)
  }

  async function renderMermaid() {
    // de-init any other diagrams
    for (const node of nodes) {
      node.removeAttribute("data-processed")
      const oldText = textMapping.get(node)
      if (oldText) {
        node.innerHTML = oldText
      }
    }

    const computedStyleMap = cssVars.reduce(
      (acc, key) => {
        acc[key] = window.getComputedStyle(document.documentElement).getPropertyValue(key)
        return acc
      },
      {} as Record<(typeof cssVars)[number], string>,
    )
    const darkMode = document.documentElement.getAttribute("saved-theme") === "dark"
    const quadrantTextColor = darkMode ? LIGHT_TEXT : "#334155"

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "base",
      themeVariables: {
        fontFamily: computedStyleMap["--bodyFont"],
        fontSize: "14px",
        // Always use dark text so it stays readable over the hardcoded
        // light-pastel fills that diagrams use via inline `style` directives.
        // CSS cannot override inline SVG style attributes, so we fix it here.
        textColor: "#172033",
        primaryColor: "#dbeafe",
        primaryTextColor: "#172033",
        primaryBorderColor: "#6b9fd4",
        lineColor: "#475569",
        secondaryColor: "#dcfce7",
        tertiaryColor: "#ede9fe",
        clusterBkg: "#f8fbff",
        clusterBorder: "#93b8d8",
        edgeLabelBackground: "#ffffff",
        titleColor: "#172033",
        nodeBorder: "#6b9fd4",
        noteTextColor: "#172033",
        tertiaryTextColor: "#172033",
        quadrant1TextFill: quadrantTextColor,
        quadrant2TextFill: quadrantTextColor,
        quadrant3TextFill: quadrantTextColor,
        quadrant4TextFill: quadrantTextColor,
        quadrantPointFill: darkMode ? "#1e293b" : "#1e293b",
        quadrantPointTextFill: quadrantTextColor,
        quadrantXAxisTextFill: quadrantTextColor,
        quadrantYAxisTextFill: quadrantTextColor,
        quadrantInternalBorderStrokeFill: "#6b9fd4",
        quadrantExternalBorderStrokeFill: "#6b9fd4",
        quadrantTitleFill: quadrantTextColor,
        // Mindmap branch colors — cScale is derived from primary/secondary/tertiary
        // when not set explicitly, which produced all-gray after our neutral overrides.
        cScale0: "#74c0fc",
        cScale1: "#8ce99a",
        cScale2: "#ffc078",
        cScale3: "#e599f7",
        cScale4: "#ffe066",
        cScale5: "#ff8787",
        cScale6: "#a9e34b",
        cScale7: "#66d9e8",
        cScale8: "#ffa94d",
        cScale9: "#da77f2",
        cScale10: "#69db7c",
        cScale11: "#f783ac",
      },
      flowchart: {
        useMaxWidth: false,
        htmlLabels: true,
        nodeSpacing: 40,
        rankSpacing: 50,
        padding: 18,
      },
      mindmap: {
        padding: 32,
      },
      quadrantChart: {
        chartWidth: 640,
        chartHeight: 560,
        titleFontSize: 24,
        quadrantLabelFontSize: 18,
        xAxisLabelFontSize: 20,
        yAxisLabelFontSize: 20,
        pointLabelFontSize: 16,
        titlePadding: 18,
        xAxisLabelPadding: 12,
        yAxisLabelPadding: 12,
        quadrantPadding: 14,
      },
    })

    await mermaid.run({ nodes })

    if (darkMode) {
      for (const node of nodes) {
        const svg = node.querySelector("svg")
        if (svg) {
          applyDarkTheme(svg, typeMapping.get(node) ?? "")
        }
      }
    }
  }

  await renderMermaid()
  document.addEventListener("themechange", renderMermaid)
  window.addCleanup(() => document.removeEventListener("themechange", renderMermaid))

  for (let i = 0; i < nodes.length; i++) {
    const codeBlock = nodes[i] as HTMLElement
    const pre = codeBlock.parentElement as HTMLPreElement
    const clipboardBtn = pre.querySelector(".clipboard-button") as HTMLButtonElement
    const expandBtn = pre.querySelector(".expand-button") as HTMLButtonElement

    const clipboardStyle = window.getComputedStyle(clipboardBtn)
    const clipboardWidth =
      clipboardBtn.offsetWidth +
      parseFloat(clipboardStyle.marginLeft || "0") +
      parseFloat(clipboardStyle.marginRight || "0")

    // Set expand button position
    expandBtn.style.right = `calc(${clipboardWidth}px + 0.3rem)`
    pre.prepend(expandBtn)

    // query popup container
    const popupContainer = pre.querySelector("#mermaid-container") as HTMLElement
    if (!popupContainer) return

    let panZoom: DiagramPanZoom | null = null
    function showMermaid() {
      const container = popupContainer.querySelector("#mermaid-space") as HTMLElement
      const content = popupContainer.querySelector(".mermaid-content") as HTMLElement
      if (!content) return
      removeAllChildren(content)

      // Clone the mermaid content
      const mermaidContent = codeBlock.querySelector("svg")!.cloneNode(true) as SVGElement
      content.appendChild(mermaidContent)

      // Show container
      popupContainer.classList.add("active")
      container.style.cursor = "grab"

      // Initialize pan-zoom after showing the popup
      panZoom = new DiagramPanZoom(container, content)
    }

    function hideMermaid() {
      popupContainer.classList.remove("active")
      panZoom?.cleanup()
      panZoom = null
    }

    expandBtn.addEventListener("click", showMermaid)
    registerEscapeHandler(popupContainer, hideMermaid)

    window.addCleanup(() => {
      panZoom?.cleanup()
      expandBtn.removeEventListener("click", showMermaid)
    })
  }
})
