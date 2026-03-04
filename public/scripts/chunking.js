// Simple chunking for large chats
class ChatChunker {
    constructor() {
        this.chunkSize = 150; // 150 messages per chunk
    }

    async saveLargeChat(chatData) {
        console.log('Using chunking for large chat');

        const threadId = 'chat_' + Date.now();
        const messages = chatData.messages;
        const totalChunks = Math.ceil(messages.length / this.chunkSize);

        console.log(`Splitting ${messages.length} messages into ${totalChunks} chunks`);

        // Send each chunk
        for (let chunkNum = 0; chunkNum < totalChunks; chunkNum++) {
            const start = chunkNum * this.chunkSize;
            const end = start + this.chunkSize;
            const chunk = messages.slice(start, end);

            console.log(`Sending chunk ${chunkNum + 1}/${totalChunks} (${chunk.length} messages)`);

            await fetch('/api/save-chunk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    threadId,
                    chunkIndex: chunkNum,
                    totalChunks,
                    messages: chunk
                })
            });
        }

        // Finalize
        console.log('All chunks sent, finalizing...');
        const response = await fetch('/api/finalize-thread', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId })
        });

        const result = await response.json();
        console.log('Chunking complete:', result);
        return result;
    }
}

// Make it available
window.chatChunker = new ChatChunker();