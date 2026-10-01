import { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, ImageOff, Loader2, Send, Sparkles, TriangleAlert, Upload, X } from 'lucide-react'
import type { AiThumbnail } from '../../preload/index'
import type { ClipArtifact } from '../store/use-job-store'
import { getApi } from '../lib/ipc'
import { clipFilePath } from '../lib/thumbnails'
import { cn, errorMessage, isMac, localFileUrl } from '../lib/utils'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Field, TextArea, TextInput } from './ui/Field'

const MAX_TITLE = 200
const MAX_DESCRIPTION = 5000

interface ClipEditDialogProps {
  clip: ClipArtifact
  vertical: boolean
  /** The clip's thumbnail state, owned (and polled) by the clip card. */
  thumbnail: AiThumbnail | null
  /** Fallback picture while there is no thumbnail: a frame of the clip. */
  frame: string | null
  onThumbnail: (state: AiThumbnail | null) => void
  onSaved: (clip: ClipArtifact) => void
  /** Opens the post dialog for this clip, with the saved text. Hidden when posting isn't available here. */
  onPost?: (clip: ClipArtifact) => void
  onClose: () => void
}

/**
 * Edit a rendered clip: its title and description (used when posting) and its
 * thumbnail, either the user's own picture or a newly generated one.
 */
export function ClipEditDialog({ clip, vertical, thumbnail, frame, onThumbnail, onSaved, onPost, onClose }: ClipEditDialogProps): React.JSX.Element {
  const filePath = clipFilePath(clip.s3_url)
  const [title, setTitle] = useState(clip.summary ?? '')
  const [description, setDescription] = useState(clip.description ?? '')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<'upload' | 'generate' | 'post' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const changed = title.trim() !== (clip.summary ?? '').trim() || description.trim() !== (clip.description ?? '').trim()
  const pending = thumbnail?.status === 'pending'
  const image = thumbnail?.status === 'ready' && thumbnail.path ? `${localFileUrl(thumbnail.path)}?v=${encodeURIComponent(thumbnail.updatedAt)}` : null

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await getApi().clips.updateDetails(filePath, { title, description }))
      onClose()
    } catch (err) {
      setError(errorMessage(err, 'Could not save the clip details.'))
    } finally {
      setSaving(false)
    }
  }

  // Post what is on screen: unsaved text is saved first so the caption uses it.
  const post = async (): Promise<void> => {
    if (!onPost) return
    setBusy('post')
    setError(null)
    try {
      let latest = clip
      if (changed) {
        if (!title.trim()) throw new Error('Give the clip a title first.')
        latest = await getApi().clips.updateDetails(filePath, { title, description })
        onSaved(latest)
      }
      onClose()
      onPost(latest)
    } catch (err) {
      setError(errorMessage(err, 'Could not save the clip details.'))
      setBusy(null)
    }
  }

  const upload = async (): Promise<void> => {
    setBusy('upload')
    setError(null)
    try {
      const state = await getApi().thumbnails.upload(filePath)
      if (state) onThumbnail(state)
    } catch (err) {
      setError(errorMessage(err, 'Could not use that picture.'))
    } finally {
      setBusy(null)
    }
  }

  // Opens the folder with the thumbnail selected, e.g. to upload it to YouTube Studio by hand.
  const showThumbnail = async (path: string): Promise<void> => {
    setError(null)
    try {
      if (!await getApi().shell.showItemInFolder(path)) setError('The thumbnail file is no longer there.')
    } catch (err) {
      setError(errorMessage(err, 'Could not show the thumbnail file.'))
    }
  }

  const generate = async (): Promise<void> => {
    setBusy('generate')
    setError(null)
    try {
      // The thumbnail is made from the saved text, so save what was typed first.
      if (changed) {
        if (!title.trim()) throw new Error('Give the clip a title first.')
        onSaved(await getApi().clips.updateDetails(filePath, { title, description }))
      }
      onThumbnail(await getApi().thumbnails.aiGenerate(filePath))
    } catch (err) {
      setError(errorMessage(err, 'Could not start the thumbnail.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog ref={dialogRef} aria-labelledby={titleId} onBackdropMouseDown={() => { if (!saving) onClose() }} panelClassName="max-w-[1040px]">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id={titleId} className="text-lg font-semibold text-ink">Edit clip</h2>
          <p className="mt-1 text-sm text-ink-muted">The title and description are used when you post this clip.</p>
        </div>
        <Button variant="ghost" iconOnly aria-label="Close" icon={<X className="h-4 w-4" />} onClick={onClose} disabled={saving} />
      </div>

      <div className="grid gap-5 overflow-y-auto px-5 py-5 sm:grid-cols-[minmax(0,1fr)_220px] lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        <div className="space-y-2 sm:col-span-2 lg:col-span-1">
          <p className="text-sm font-medium text-ink">Preview</p>
          <div className={cn('relative mx-auto overflow-hidden rounded-xl bg-black shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]', vertical ? 'aspect-[9/16] w-full max-w-[220px]' : 'aspect-video w-full')}>
            <video
              src={localFileUrl(filePath)}
              poster={image ?? (frame ? localFileUrl(frame) : undefined)}
              controls
              playsInline
              preload="metadata"
              className="absolute inset-0 h-full w-full object-contain"
            />
          </div>
        </div>
        <div className="space-y-4">
          <Field label="Title" htmlFor={`${titleId}-title`} aside={<span className="font-mono text-2xs tabular text-ink-faint">{title.length}/{MAX_TITLE}</span>}>
            <TextInput id={`${titleId}-title`} value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor={`${titleId}-description`} aside={<span className="font-mono text-2xs tabular text-ink-faint">{description.length}/{MAX_DESCRIPTION}</span>}>
            <TextArea
              id={`${titleId}-description`}
              rows={9}
              value={description}
              maxLength={MAX_DESCRIPTION}
              placeholder="What happens in this clip. It becomes the start of the post caption."
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Thumbnail</p>
          <div className={cn('relative overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]', vertical ? 'aspect-[9/16] max-h-[340px]' : 'aspect-video')}>
            {image ? (
              <img src={image} alt="Clip thumbnail" className="absolute inset-0 h-full w-full object-cover" />
            ) : frame ? (
              <img src={localFileUrl(frame)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-50" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-ink-subtle"><ImageOff className="h-6 w-6" /></div>
            )}
            {!image && !pending && (
              <span className="glass-chip absolute inset-x-2 bottom-2 rounded-full px-2 py-1 text-center text-2xs text-white/95">No thumbnail yet</span>
            )}
            {pending && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 text-xs text-white">
                <Loader2 className="h-5 w-5 animate-spin" /> Generating…
              </div>
            )}
          </div>
          {thumbnail?.error && (
            <p className="flex gap-1.5 text-xs text-warning"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{thumbnail.error}</p>
          )}
          {thumbnail?.status === 'ready' && !thumbnail.error && (
            <p className="text-2xs text-ink-subtle">{thumbnail.model === 'custom' ? 'Your own picture' : `Generated${thumbnail.model ? ` with ${thumbnail.model}` : ''}`}</p>
          )}
          <Button className="w-full" icon={<Upload className="h-3.5 w-3.5" />} loading={busy === 'upload'} disabled={busy !== null || pending} onClick={() => { void upload() }}>
            Upload my own picture
          </Button>
          <Button className="w-full" icon={<Sparkles className="h-3.5 w-3.5" />} loading={busy === 'generate'} disabled={busy !== null || pending} onClick={() => { void generate() }}>
            {image ? 'Generate new one' : 'Generate thumbnail'}
          </Button>
          {image && thumbnail?.path && (
            <Button className="w-full" icon={<FolderOpen className="h-3.5 w-3.5" />} disabled={pending} onClick={() => { void showThumbnail(thumbnail.path!) }}>
              {isMac ? 'Show in Finder' : 'Show thumbnail file'}
            </Button>
          )}
          <p className="text-2xs text-ink-subtle">Generating saves the title and description above, then uses them with the prompt and model from Settings → Thumbnails.</p>
        </div>
      </div>

      {error && <p role="alert" className="mx-5 mb-3 rounded-lg border border-danger/30 bg-danger/[0.06] p-3 text-sm text-danger">{error}</p>}
      <DialogFooter>
        <Button onClick={onClose} disabled={saving || busy === 'post'}>{changed ? 'Cancel' : 'Close'}</Button>
        <Button loading={saving} disabled={!changed || !title.trim() || busy !== null} onClick={() => { void save() }}>Save</Button>
        {onPost && (
          <Button
            variant="primary"
            icon={<Send className="h-3.5 w-3.5" />}
            loading={busy === 'post'}
            disabled={saving || busy !== null || pending || !title.trim()}
            title={pending ? 'Wait until the thumbnail is ready' : changed ? 'Saves your changes, then opens posting' : 'Post to your social accounts'}
            onClick={() => { void post() }}
          >
            {changed ? 'Save and post' : 'Post'}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
