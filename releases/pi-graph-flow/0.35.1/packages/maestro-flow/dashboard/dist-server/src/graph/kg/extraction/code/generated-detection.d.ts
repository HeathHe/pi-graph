/**
 * 检测文件是否为生成文件 (generated code)
 * 用途: 搜索结果降权 (排最后), dominant file 检测排除, 不硬过滤 (仍在图中)
 */
export declare function isGeneratedFile(filePath: string): boolean;
/**
 * 判断文件是否应该被降权处理 (生成文件或测试文件)
 */
export declare function shouldDegradeInSearch(filePath: string): boolean;
/**
 * 测试文件检测 (用于搜索降权)
 */
export declare function isTestFile(filePath: string): boolean;
