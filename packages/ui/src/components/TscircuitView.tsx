import React from 'react';
import { CircuitJsonPreview } from "@tscircuit/runframe";
import type { Node, Edge } from 'reactflow';
import { airToSoup } from '../utils/airToSoup';

interface TscircuitViewProps {
  nodes: Node[];
  edges: Edge[];
}

const TscircuitView: React.FC<TscircuitViewProps> = ({ nodes, edges }) => {
  const soup = airToSoup(nodes, edges);

  return (
    <div className="tscircuit-view" style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <CircuitJsonPreview
        circuitJson={soup}
        showCodeTab={false}
        defaultActiveTab="pcb"
      />
    </div>
  );
};

export default TscircuitView;
