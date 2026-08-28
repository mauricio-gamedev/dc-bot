package io.github.astromg01.miovoice;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

final class NeuralVoiceStore {
    static final String HUBERT = "hubert.onnx";
    static final String RMVPE = "rmvpe.onnx";
    static final String SYNTH = "voice.onnx";

    private NeuralVoiceStore() {}

    static File directory(Context context) {
        File dir = new File(context.getFilesDir(), "mio-neural");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("neural_directory_failed");
        }
        return dir;
    }

    static File file(Context context, String name) {
        return new File(directory(context), name);
    }

    static boolean has(Context context, String name) {
        File file = file(context, name);
        return file.isFile() && file.length() > 1024;
    }

    static File importModel(Context context, Uri uri, String targetName) throws Exception {
        if (uri == null) throw new IllegalArgumentException("model_uri_missing");
        File target = file(context, targetName);
        File temp = new File(target.getParentFile(), target.getName() + ".part");
        if (temp.exists()) temp.delete();

        long copied = 0L;
        try (InputStream input = context.getContentResolver().openInputStream(uri);
             FileOutputStream output = new FileOutputStream(temp)) {
            if (input == null) throw new IllegalStateException("model_open_failed");
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read == 0) continue;
                output.write(buffer, 0, read);
                copied += read;
            }
            output.getFD().sync();
        }

        if (copied < 1024L) {
            temp.delete();
            throw new IllegalArgumentException("model_too_small");
        }
        if (target.exists() && !target.delete()) {
            temp.delete();
            throw new IllegalStateException("model_replace_failed");
        }
        if (!temp.renameTo(target)) {
            temp.delete();
            throw new IllegalStateException("model_commit_failed");
        }
        return target;
    }

    static String displayName(Context context, Uri uri) {
        String fallback = "voz personalizada";
        if (uri == null) return fallback;
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String value = cursor.getString(index);
                    if (value != null && !value.isBlank()) {
                        int dot = value.lastIndexOf('.');
                        return dot > 0 ? value.substring(0, dot) : value;
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return fallback;
    }

    static String status(Context context) {
        boolean hubert = has(context, HUBERT);
        boolean rmvpe = has(context, RMVPE);
        boolean synth = has(context, SYNTH);
        if (hubert && rmvpe && synth) return "pronto";
        StringBuilder missing = new StringBuilder();
        if (!hubert) missing.append("ContentVec/HuBERT");
        if (!rmvpe) appendMissing(missing, "RMVPE");
        if (!synth) appendMissing(missing, "voz RVC");
        return "faltando " + missing;
    }

    private static void appendMissing(StringBuilder builder, String item) {
        if (builder.length() > 0) builder.append(" + ");
        builder.append(item);
    }
}
