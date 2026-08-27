import { useEffect, useRef, useState } from 'react';

// Minimal dependency-free crop/position tool: the image pans (drag) and zooms
// (slider) inside a fixed-aspect viewport matching how it will be displayed;
// output is rendered to an offscreen canvas at the target resolution.
interface Props {
  file: File;
  aspect: number; // width / height of the crop frame
  outWidth: number;
  outType: 'image/jpeg' | 'image/png';
  title: string;
  onDone: (blob: Blob) => void;
  onCancel: () => void;
}

const VIEW_W = 440;

export function ImageCropper({ file, aspect, outWidth, outType, title, onDone, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [zoom, setZoom] = useState(1); // multiplier over the cover scale
  const offset = useRef({ x: 0, y: 0 }); // top-left of the drawn image, viewport px
  const drag = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const viewH = Math.round(VIEW_W / aspect);

  const coverScale = () => {
    const img = imgRef.current!;
    return Math.max(VIEW_W / img.naturalWidth, viewH / img.naturalHeight);
  };

  const clampOffset = () => {
    const img = imgRef.current!;
    const s = coverScale() * zoom;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    offset.current.x = Math.min(0, Math.max(VIEW_W - w, offset.current.x));
    offset.current.y = Math.min(0, Math.max(viewH - h, offset.current.y));
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d')!;
    const s = coverScale() * zoom;
    ctx.fillStyle = '#0a101f';
    ctx.fillRect(0, 0, VIEW_W, viewH);
    ctx.drawImage(img, offset.current.x, offset.current.y, img.naturalWidth * s, img.naturalHeight * s);
  };

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      // Centre the cover-fit image.
      const s = Math.max(VIEW_W / img.naturalWidth, viewH / img.naturalHeight);
      offset.current = {
        x: (VIEW_W - img.naturalWidth * s) / 2,
        y: (viewH - img.naturalHeight * s) / 2,
      };
      setLoaded(true);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, viewH]);

  useEffect(() => {
    if (!loaded) return;
    clampOffset();
    draw();
  });

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, ox: offset.current.x, oy: offset.current.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    // Pointer deltas are CSS px; the canvas may render scaled-down on mobile.
    const el = e.target as HTMLCanvasElement;
    const k = el.clientWidth ? VIEW_W / el.clientWidth : 1;
    offset.current = {
      x: drag.current.ox + (e.clientX - drag.current.startX) * k,
      y: drag.current.oy + (e.clientY - drag.current.startY) * k,
    };
    clampOffset();
    draw();
  };
  const onPointerUp = () => (drag.current = null);

  const crop = () => {
    const img = imgRef.current;
    if (!img) return;
    const out = document.createElement('canvas');
    out.width = outWidth;
    out.height = Math.round(outWidth / aspect);
    const ctx = out.getContext('2d')!;
    const f = outWidth / VIEW_W; // viewport px -> output px
    const s = coverScale() * zoom * f;
    if (outType === 'image/jpeg') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.drawImage(img, offset.current.x * f, offset.current.y * f, img.naturalWidth * s, img.naturalHeight * s);
    out.toBlob((blob) => blob && onDone(blob), outType, 0.9);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal cropper" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="muted small">Drag to position, slide to zoom — the frame is exactly how it will appear.</p>
        <canvas
          ref={canvasRef}
          width={VIEW_W}
          height={viewH}
          className="cropper-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="form-row cropper-controls">
          <label style={{ flex: 1 }}>
            Zoom
            <input
              type="range"
              min={1}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={crop} disabled={!loaded}>
            Crop & upload
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
