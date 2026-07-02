import type { Node, Edge } from 'reactflow';

/**
 * Enhanced translation from AIR React Flow data to TSCircuit Soup.
 */
export function airToSoup(nodes: Node[], edges: Edge[]) {
  const soup: any[] = [];
  
  // 1. Components
  nodes.filter(n => n.type === 'component').forEach(node => {
    const id = node.id;
    const type = node.data?.type || 'resistor';
    const name = node.data?.label || id;
    const value = node.data?.value || node.data?.part || "";

    // Map AIR types to TSCircuit source components
    const sourceComp: any = {
      type: "source_component",
      source_component_id: id,
      name: name,
    };

    if (type === 'resistor') {
      sourceComp.ftype = 'resistor';
      sourceComp.resistance = value || '1k';
    } else if (type === 'capacitor') {
      sourceComp.ftype = 'capacitor';
      sourceComp.capacitance = value || '10uF';
    } else if (type === 'mcu') {
      sourceComp.ftype = 'chip';
    } else if (type === 'voltage_source') {
      sourceComp.ftype = 'power_source';
    }

    soup.push(sourceComp);

    // Schematic Representation
    soup.push({
      type: "schematic_component",
      schematic_component_id: `schem_${id}`,
      source_component_id: id,
      center: { x: node.position.x / 10, y: -node.position.y / 10 },
      rotation: 0
    });

    // PCB Representation
    soup.push({
      type: "pcb_component",
      pcb_component_id: `pcb_${id}`,
      source_component_id: id,
      center: { x: node.position.x / 20, y: node.position.y / 20 },
    });
  });

  // 2. Nets & Connectivity
  // Group edges by net if possible, or just create individual traces
  edges.forEach((edge, idx) => {
    soup.push({
      type: "schematic_trace",
      schematic_trace_id: `trace_${idx}`,
      source_port_ids: [edge.source, edge.target]
    });
    
    soup.push({
      type: "pcb_trace",
      pcb_trace_id: `pcb_trace_${idx}`,
      source_port_ids: [edge.source, edge.target],
      route: [] // TSCircuit will auto-route if empty
    });
  });

  return soup;
}
