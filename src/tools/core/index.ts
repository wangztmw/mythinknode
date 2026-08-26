import { type Tools } from './Tool.js';
import { BashTool } from '../exec/BashTool/BashTool.js';
import { FileReadTool } from '../file/FileReadTool/FileReadTool.js';
import { FileWriteTool } from '../file/FileWriteTool/FileWriteTool.js';
import { FileEditTool } from '../file/FileEditTool/FileEditTool.js';
import { GlobTool } from '../file/GlobTool/GlobTool.js';
import { GrepTool } from '../file/GrepTool/GrepTool.js';
import { WebSearchTool } from '../search/WebSearchTool/WebSearchTool.js';
import { WebFetchTool } from '../search/WebFetchTool/WebFetchTool.js';
import { MCPTool } from '../external/MCPTool/MCPTool.js';
import { SkillTool } from '../external/SkillTool/SkillTool.js';
import { AgentTool } from '../agent/AgentTool/AgentTool.js';
import { KnowledgeTool } from '../nodemind/KnowledgeTool/KnowledgeTool.js';
import { RememberTool } from '../nodemind/RememberTool/RememberTool.js';
import { InferTool } from '../infermem/InferTool/InferTool.js';
import { InferQueryTool } from '../infermem/InferQueryTool/InferQueryTool.js';
import { TraitGraphTool } from '../traitgraph/TraitGraphTool/TraitGraphTool.js';

export function getAllTools(): Tools {
  return [
    BashTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    WebSearchTool,
    WebFetchTool,
    MCPTool,
    SkillTool,
    AgentTool,
    KnowledgeTool,
    RememberTool,
    InferTool,
    InferQueryTool,
    TraitGraphTool,
  ].filter(t => t.isEnabled());
}
