const DEFAULT_CHUNK_SIZE = 150;
const DEFAULT_CHUNKING_THRESHOLD = 750;

function makeThreadId() {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function postJson(url, payload, headers = {}) {
    const response = await fetch(url, {
        method: 'POST',
        cache: 'no-cache',
        headers,
        body: JSON.stringify(payload),
    });

    let responseBody = null;
    try {
        responseBody = await response.json();
    } catch {
        responseBody = null;
    }

    if (response.ok) {
        return responseBody || { ok: true };
    }

    const err = new Error(responseBody?.error || `Request failed (${response.status})`);
    if (responseBody?.error === 'integrity') {
        err.code = 'integrity';
    }
    err.status = response.status;
    err.payload = responseBody;
    throw err;
}

function shouldUseChunkedChatSave(messageCount, threshold = DEFAULT_CHUNKING_THRESHOLD) {
    return Number(messageCount || 0) > Number(threshold || DEFAULT_CHUNKING_THRESHOLD);
}

async function saveChatInChunks({
    chatData,
    avatarUrl,
    fileName,
    cardName,
    force = false,
    headers,
    chunkSize = DEFAULT_CHUNK_SIZE,
}) {
    const messages = Array.isArray(chatData) ? chatData : [];
    if (messages.length === 0) {
        throw new Error('Chunked save requires a non-empty chat array.');
    }

    const effectiveChunkSize = Math.max(1, Number(chunkSize || DEFAULT_CHUNK_SIZE));
    const threadId = makeThreadId();
    const totalChunks = Math.ceil(messages.length / effectiveChunkSize);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * effectiveChunkSize;
        const end = start + effectiveChunkSize;
        const chatChunk = messages.slice(start, end);

        await postJson('/api/chats/save-chunk', {
            thread_id: threadId,
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            chat_chunk: chatChunk,
            avatar_url: avatarUrl,
            file_name: fileName,
            ch_name: cardName,
            force: !!force,
        }, headers);
    }

    return await postJson('/api/chats/finalize-chunked-save', {
        thread_id: threadId,
    }, headers);
}

window.chatChunking = {
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CHUNKING_THRESHOLD,
    shouldUseChunkedChatSave,
    saveChatInChunks,
};
