import React, { useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { format, parseISO, isValid, startOfMinute, parse } from 'date-fns';
import { Upload, FileSpreadsheet, Settings, Download, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// Types
type AggregationMethod = 'average' | 'sum' | 'first' | 'last' | 'max' | 'min';

interface ProcessedData {
  fileName: string;
  data: any[];
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewData, setPreviewData] = useState<any[]>([]);
  
  // Configuration State
  const [timeColumn, setTimeColumn] = useState<string>('');
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [aggregationMethod, setAggregationMethod] = useState<AggregationMethod>('average');
  const [fileEncoding, setFileEncoding] = useState<string>('UTF-8');
  const [downloadFilename, setDownloadFilename] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  
  // Processing State
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedResult, setProcessedResult] = useState<ProcessedData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readFile = (file: File, encoding: string): Promise<XLSX.WorkBook> => {
    return new Promise((resolve, reject) => {
      const isCSV = file.name.toLowerCase().endsWith('.csv');
      
      if (isCSV && encoding === 'GBK') {
        const reader = new FileReader();
        reader.onload = (e) => {
           try {
             const text = e.target?.result as string;
             const wb = XLSX.read(text, { type: 'string', cellDates: true });
             resolve(wb);
           } catch (err) {
             reject(err);
           }
        };
        reader.onerror = reject;
        reader.readAsText(file, 'GBK');
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
           try {
             const ab = e.target?.result;
             const wb = XLSX.read(ab, { type: 'array', cellDates: true });
             resolve(wb);
           } catch (err) {
             reject(err);
           }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      }
    });
  };

  const processFile = async (uploadedFile: File) => {
    setFile(uploadedFile);
    setError(null);
    setProcessedResult(null);
    
    try {
      const wb = await readFile(uploadedFile, fileEncoding);
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      
      if (data.length > 0) {
        const headerRow = data[0] as string[];
        setHeaders(headerRow);
        // Preview first 5 rows
        setPreviewData(data.slice(1, 6));
        
        // Auto-detect time column (simple heuristic: looks for 'time' or 'date')
        const potentialTime = headerRow.find(h => /time|date/i.test(h));
        if (potentialTime) setTimeColumn(potentialTime);
      }
    } catch (err) {
      setError('Failed to parse file. Please check the format or encoding.');
      console.error(err);
    }
  };

  // Handle File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;
    await processFile(uploadedFile);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      await processFile(droppedFile);
    }
  };
  
  // Re-read file when encoding changes (if file exists)
  const handleEncodingChange = async (newEncoding: string) => {
    setFileEncoding(newEncoding);
    if (file) {
      try {
        const wb = await readFile(file, newEncoding);
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
        
        if (data.length > 0) {
          const headerRow = data[0] as string[];
          setHeaders(headerRow);
          setPreviewData(data.slice(1, 6));
          // Reset selections as headers might have changed (garbled -> clear)
          setTimeColumn('');
          setSelectedColumns([]);
          
          const potentialTime = headerRow.find(h => /time|date/i.test(h));
          if (potentialTime) setTimeColumn(potentialTime);
        }
      } catch (err) {
        setError('Failed to re-parse file with new encoding.');
      }
    }
  };

  const toggleColumn = (col: string) => {
    setSelectedColumns(prev => 
      prev.includes(col) 
        ? prev.filter(c => c !== col)
        : [...prev, col]
    );
  };

  const processData = async () => {
    if (!file || !timeColumn || selectedColumns.length === 0) {
      setError('Please select a time column and at least one data column.');
      return;
    }

    setIsProcessing(true);
    setError(null);

    // Use setTimeout to allow UI to update (show loading state) before heavy processing
    setTimeout(async () => {
      try {
        const wb = await readFile(file, fileEncoding);
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const jsonData = XLSX.utils.sheet_to_json(ws);

        // Group by minute
        const groups: Record<string, any[]> = {};
        let parsedCount = 0;

        jsonData.forEach((row: any) => {
          const timeVal = row[timeColumn];
          let dateObj: Date | null = null;

          if (timeVal instanceof Date) {
            dateObj = timeVal;
          } else if (typeof timeVal === 'string') {
            // Try parsing string date
            // First try standard Date constructor
            let parsed = new Date(timeVal);
            if (isValid(parsed)) {
              dateObj = parsed;
            } else {
              // Try specific formats requested by user: dd-mm-yyyy hh-mm-ss
              // Note: date-fns uses MM for month, mm for minute, HH for 24h hour
              const formatsToTry = [
                'dd-MM-yyyy HH-mm-ss',
                'dd-MM-yyyy HH:mm:ss',
                'dd/MM/yyyy HH:mm:ss',
                'yyyy-MM-dd HH:mm:ss',
                'yyyy/MM/dd HH:mm',      // Covers yyyy/m/dd h:mm
                'yyyy/M/d H:m',          // Covers single digits
                'yyyy-MM-dd HH:mm',
                'M/d/yyyy H:mm',         // US format
                'd/M/yyyy H:mm',         // International format
                'yyyy/MM/dd HH:mm:ss',
                'MM/dd/yyyy HH:mm:ss',
                'dd.MM.yyyy HH:mm:ss'
              ];
              
              for (const fmt of formatsToTry) {
                parsed = parse(timeVal, fmt, new Date());
                if (isValid(parsed)) {
                  dateObj = parsed;
                  break;
                }
              }
            }
          } else if (typeof timeVal === 'number') {
             // Fallback for numeric dates if cellDates didn't catch it
             // Excel base date is usually Dec 30 1899
             dateObj = new Date(Math.round((timeVal - 25569) * 86400 * 1000));
          }

          if (dateObj && isValid(dateObj)) {
            // Truncate to minute
            const minuteKey = format(startOfMinute(dateObj), 'yyyy-MM-dd HH:mm');
            if (!groups[minuteKey]) groups[minuteKey] = [];
            groups[minuteKey].push(row);
            parsedCount++;
          }
        });

        if (parsedCount === 0) {
           setError(`Could not parse any valid dates from column "${timeColumn}". Please check the format.`);
           setIsProcessing(false);
           return;
        }

        // Aggregate and Construct Array of Arrays (AOA) for precise output
        // Header Row
        const outputData: any[][] = [
          [timeColumn, ...selectedColumns]
        ];

        const sortedMinutes = Object.keys(groups).sort();

        sortedMinutes.forEach(minuteKey => {
          const groupRows = groups[minuteKey];
          const rowData: any[] = [minuteKey];

          selectedColumns.forEach(col => {
            const values = groupRows.map(r => {
              const val = r[col];
              return typeof val === 'number' ? val : parseFloat(val);
            }).filter(v => !isNaN(v));

            if (values.length === 0) {
              rowData.push(null);
              return;
            }

            let aggValue;
            switch (aggregationMethod) {
              case 'average':
                aggValue = values.reduce((a, b) => a + b, 0) / values.length;
                break;
              case 'sum':
                aggValue = values.reduce((a, b) => a + b, 0);
                break;
              case 'max':
                aggValue = Math.max(...values);
                break;
              case 'min':
                aggValue = Math.min(...values);
                break;
              case 'first':
                rowData.push(groupRows[0][col]); // Push raw value directly
                return;
              case 'last':
                rowData.push(groupRows[groupRows.length - 1][col]); // Push raw value directly
                return;
              default:
                aggValue = values.reduce((a, b) => a + b, 0) / values.length;
            }
            
            // Round to 4 decimal places for cleanliness if numeric
            if (typeof aggValue === 'number') {
                rowData.push(Math.round(aggValue * 10000) / 10000);
            } else {
                rowData.push(aggValue);
            }
          });

          outputData.push(rowData);
        });

        setProcessedResult({
          fileName: `processed_${file.name}`,
          data: outputData // Now storing AOA
        });
        setDownloadFilename(`processed_${file.name}`);
        setIsProcessing(false);
      } catch (err) {
        console.error(err);
        setError('An error occurred during processing.');
        setIsProcessing(false);
      }
    }, 100);
  };

  const downloadFile = () => {
    if (!processedResult) return;
    
    // Use aoa_to_sheet for precise control
    const ws = XLSX.utils.aoa_to_sheet(processedResult.data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Processed Data");
    
    // Use the custom filename or fallback to the generated one
    const finalName = downloadFilename.trim() || processedResult.fileName;
    // Ensure extension
    const nameWithExt = finalName.toLowerCase().endsWith('.xlsx') ? finalName : `${finalName}.xlsx`;
    
    XLSX.writeFile(wb, nameWithExt);
  };

  const resetApp = () => {
    setFile(null);
    setHeaders([]);
    setPreviewData([]);
    setTimeColumn('');
    setSelectedColumns([]);
    setProcessedResult(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8 font-sans text-slate-900">
      <div className="max-w-4xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Excel/CSV Data Resampler</h1>
            <p className="text-slate-500">
              Upload your multi-dimensional Excel or CSV data. Select 6 dimensions. Downsample to 1-minute intervals.
            </p>
          </div>
          {file && (
            <button 
              onClick={resetApp}
              className="text-sm text-slate-500 hover:text-slate-800 underline"
            >
              Start Over
            </button>
          )}
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          
          {/* Step 1: Upload */}
          {!file && (
            <div className="p-8 border-b border-slate-100">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm">1</div>
                <h2 className="text-lg font-semibold">Upload Excel or CSV File</h2>
              </div>
              
              <label 
                className={cn(
                  "flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors",
                  isDragging 
                    ? "border-blue-500 bg-blue-50" 
                    : "border-slate-300 bg-slate-50 hover:bg-slate-100"
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Upload className={cn("w-8 h-8 mb-3", isDragging ? "text-blue-500" : "text-slate-400")} />
                  <p className="mb-2 text-sm text-slate-500">
                    <span className="font-semibold">Click to upload</span> or drag and drop
                  </p>
                  <p className="text-xs text-slate-500">.xlsx, .xls, or .csv files</p>
                </div>
                <input type="file" className="hidden" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} />
              </label>

              <div className="mt-4 flex items-center justify-end gap-2">
                <label className="text-sm text-slate-500">CSV Encoding:</label>
                <select 
                  value={fileEncoding}
                  onChange={(e) => handleEncodingChange(e.target.value)}
                  className="text-sm border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500"
                >
                  <option value="UTF-8">UTF-8 (Standard)</option>
                  <option value="GBK">GBK (Chinese)</option>
                </select>
              </div>
            </div>
          )}
          
          {file && !processedResult && (
            <div className="p-8 border-b border-slate-100">
               <div className="flex items-center justify-between">
                 <div className="flex items-center gap-3">
                   <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-bold text-sm"><CheckCircle2 className="w-5 h-5" /></div>
                   <div>
                     <h2 className="text-lg font-semibold">File Uploaded</h2>
                     <p className="text-sm text-slate-500">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
                   </div>
                 </div>
                 <div className="flex items-center gap-4">
                    {file.name.toLowerCase().endsWith('.csv') && (
                      <select 
                        value={fileEncoding}
                        onChange={(e) => handleEncodingChange(e.target.value)}
                        className="text-sm border-slate-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      >
                        <option value="UTF-8">UTF-8</option>
                        <option value="GBK">GBK (Chinese)</option>
                      </select>
                    )}
                    <button onClick={resetApp} className="text-sm text-slate-400 hover:text-red-500">Change File</button>
                 </div>
               </div>
            </div>
          )}

          {/* Step 2: Configure */}
          {headers.length > 0 && !processedResult && (
            <div className="p-8 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm">2</div>
                <h2 className="text-lg font-semibold">Configuration</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Time Column Selection */}
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-slate-700">Timestamp Column</label>
                  <select 
                    value={timeColumn} 
                    onChange={(e) => setTimeColumn(e.target.value)}
                    className="w-full rounded-lg border-slate-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm py-2.5"
                  >
                    <option value="">Select a column...</option>
                    {headers.map(h => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-500">This column will be used to group data by minute.</p>
                </div>

                {/* Aggregation Method */}
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-slate-700">Aggregation Method</label>
                  <select 
                    value={aggregationMethod} 
                    onChange={(e) => setAggregationMethod(e.target.value as AggregationMethod)}
                    className="w-full rounded-lg border-slate-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm py-2.5"
                  >
                    <option value="average">Average (Mean)</option>
                    <option value="sum">Sum</option>
                    <option value="max">Maximum</option>
                    <option value="min">Minimum</option>
                    <option value="first">First Value</option>
                    <option value="last">Last Value</option>
                  </select>
                  <p className="text-xs text-slate-500">How to combine multiple values within the same minute.</p>
                </div>
              </div>

              {/* Column Selection */}
              <div className="mt-8 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-slate-700">
                    Select Data Dimensions ({selectedColumns.length} selected)
                  </label>
                  {selectedColumns.length === 6 ? (
                    <span className="text-xs font-medium text-emerald-600 bg-emerald-100 px-2 py-1 rounded-full">Target Reached</span>
                  ) : (
                    <span className="text-xs text-slate-500">Target: 6 dimensions</span>
                  )}
                </div>
                
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-h-60 overflow-y-auto p-4 bg-white rounded-xl border border-slate-200">
                  {headers.map(h => (
                    <label key={h} className={cn(
                      "flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-all hover:bg-slate-50",
                      selectedColumns.includes(h) ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-slate-200"
                    )}>
                      <input 
                        type="checkbox" 
                        checked={selectedColumns.includes(h)}
                        onChange={() => toggleColumn(h)}
                        className="rounded text-blue-600 focus:ring-blue-500 border-slate-300"
                      />
                      <span className="text-sm truncate" title={h}>{h}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Action Button */}
              <div className="mt-8 flex justify-end">
                <button
                  onClick={processData}
                  disabled={isProcessing || !timeColumn || selectedColumns.length === 0}
                  className={cn(
                    "flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white shadow-sm transition-all",
                    isProcessing 
                      ? "bg-slate-400 cursor-not-allowed" 
                      : "bg-blue-600 hover:bg-blue-700 hover:shadow-md active:scale-95"
                  )}
                >
                  {isProcessing ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Settings className="w-5 h-5" />
                      Process Data
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Results */}
          {processedResult && (
            <div className="p-8 bg-emerald-50/50">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 font-bold text-sm">3</div>
                <h2 className="text-lg font-semibold text-emerald-900">Processing Complete!</h2>
              </div>

              <div className="bg-white rounded-xl border border-emerald-100 p-6 shadow-sm space-y-6">
                <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                  <div>
                    <h3 className="font-medium text-slate-900">Ready for Download</h3>
                    <p className="text-sm text-slate-500 mt-1">
                      Processed {processedResult.data.length} rows (1-minute intervals).
                      <br/>
                      Includes {selectedColumns.length} data dimensions.
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 w-full md:w-auto">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-slate-500">Filename</label>
                        <input 
                            type="text" 
                            value={downloadFilename}
                            onChange={(e) => setDownloadFilename(e.target.value)}
                            className="text-sm border-slate-300 rounded-lg shadow-sm focus:border-emerald-500 focus:ring-emerald-500 px-3 py-2 w-full md:w-64"
                            placeholder="Enter filename..."
                        />
                    </div>
                    <div className="flex gap-3 w-full md:w-auto">
                        <button
                            onClick={resetApp}
                            className="px-4 py-3 rounded-xl font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 shadow-sm transition-all w-full md:w-auto"
                        >
                            Process Another
                        </button>
                        <button
                            onClick={downloadFile}
                            className="flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm hover:shadow-md transition-all active:scale-95 w-full md:w-auto justify-center"
                        >
                            <Download className="w-5 h-5" />
                            Download Excel
                        </button>
                    </div>
                  </div>
                </div>

                {/* Preview Table */}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        Preview (First 5 Rows)
                    </div>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-200">
                            <thead className="bg-slate-50">
                                <tr>
                                    {processedResult.data[0].map((header: string, idx: number) => (
                                        <th key={idx} className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                                            {header}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-slate-200">
                                {processedResult.data.slice(1, 6).map((row, rowIdx) => (
                                    <tr key={rowIdx}>
                                        {row.map((cell: any, cellIdx: number) => (
                                            <td key={cellIdx} className="px-4 py-2 whitespace-nowrap text-sm text-slate-500">
                                                {cell}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-t border-red-100 flex items-center gap-3 text-red-700">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
