import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CitationList({ citations }) {
  const visibleCitations = (citations || []).filter(
    (c) => c.type !== 'url' || !/^mcp:\/\//i.test(c.url)
  );

  if (!visibleCitations.length) return null;

  return (
    <div className="citations">
      <div className="citations-label">Sources:</div>
      <ul className="citations-list">
        {visibleCitations.map((c, i) => (
          <li key={i}>
            {c.type === 'url' ? (
              <a href={c.url} target="_blank" rel="noopener noreferrer">
                {c.title}
              </a>
            ) : (
              <span className="citation-file">{c.filename}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ChatMessage({ role, content, citations, isLoading = false }) {
  const isUser = role === 'user';

  return (
    <div className={`chat-message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-bubble">
        {isUser ? (
          content
        ) : isLoading ? (
          <div className="typing-indicator" aria-label="Assistant is typing">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            <CitationList citations={citations} />
          </>
        )}
      </div>
    </div>
  );
}
