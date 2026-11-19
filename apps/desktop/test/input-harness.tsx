import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../src/style.css';
import MessageInput from '../src/MessageInput.tsx';

function Harness() {
  const [text, setText] = useState('Please read "C:\\work\\my file.txt" next');
  Reflect.set(window, 'currentText', text);
  return (
    <MessageInput
      value={text}
      onChange={setText}
      windows
      disabled={false}
      placeholder="message"
      aria-controls="commands"
      aria-expanded={true}
      aria-autocomplete="list"
      aria-activedescendant="command-one"
      onKeyDown={() => {}}
      onPaste={() => {}}
    />
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
