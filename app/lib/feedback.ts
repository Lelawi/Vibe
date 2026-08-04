import { Platform } from 'react-native';
import { supabase } from './supabase';

// Web-only Datei-Auswahl über ein unsichtbares <input type=file> — gleiches
// Prinzip wie der synthetische <a>-Klick in openExternalUrl.ts: die App ist
// ohnehin nur als PWA (Web) verteilt (siehe CLAUDE.md), ein natives
// RN-Bildpicker-Modul wäre hier unnötige Komplexität für eine Plattform, die
// gar nicht ausgeliefert wird.
export function pickScreenshot(): Promise<File | null> {
  return new Promise((resolve) => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

// Clientseitig skalieren/komprimieren statt Rohbilder (oft mehrere MB bei
// Handyfotos) direkt hochzuladen — hält das kostenlose 1GB-Supabase-
// Storage-Kontingent bei vielen Meldungen deutlich länger nutzbar.
async function compressImage(file: File, maxWidth = 1600, quality = 0.8): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Bitte eine Bilddatei auswählen');
  if (file.size > 15 * 1024 * 1024) throw new Error('Das Bild darf höchstens 15 MB groß sein');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context not available');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas toBlob failed'))), 'image/jpeg', quality);
  });
}

export async function submitFeedback(
  message: string,
  screenshot: File | null,
  pageContext: string
): Promise<{ ok: boolean; error?: string }> {
  const feedbackId = crypto.randomUUID();
  let screenshotPath: string | null = null;
  if (screenshot) {
    try {
      const blob = await compressImage(screenshot);
      if (blob.size > 5 * 1024 * 1024) throw new Error('Das komprimierte Bild ist noch zu groß');
      const path = `${feedbackId}/screenshot.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('feedback-screenshots')
        .upload(path, blob, { contentType: 'image/jpeg' });
      if (uploadError) return { ok: false, error: uploadError.message };
      screenshotPath = path;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Bild-Upload fehlgeschlagen' };
    }
  }

  const { error } = await supabase.from('app_feedback').insert({
    id: feedbackId,
    message,
    screenshot_path: screenshotPath,
    page_context: pageContext,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type MissingItemInput = {
  kind: 'event' | 'location';
  name: string;
  eventDate?: string;
  location?: string;
  sourceUrl?: string;
  note?: string;
  pageContext: string;
};

export async function submitMissingItem(input: MissingItemInput): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('missing_items').insert({
    kind: input.kind,
    name: input.name.trim(),
    event_date: input.kind === 'event' && input.eventDate?.trim() ? input.eventDate.trim() : null,
    location: input.location?.trim() || null,
    source_url: input.sourceUrl?.trim() || null,
    note: input.note?.trim() || null,
    page_context: input.pageContext,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
