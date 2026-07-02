import React from 'react';
import Editor from '@monaco-editor/react';

interface XmlEditorProps {
  xml: string;
  onChange: (value: string | undefined) => void;
  theme?: 'dark' | 'light';
}

const XmlEditor: React.FC<XmlEditorProps> = ({ xml, onChange, theme = 'dark' }) => {
  return (
    <div className="editor-container">
      <Editor
        height="100%"
        defaultLanguage="xml"
        theme={theme === 'dark' ? 'vs-dark' : 'light'}
        value={xml}
        onChange={onChange}
        options={{
          minimap: { enabled: true },
          fontSize: 14,
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
};

export default XmlEditor;
