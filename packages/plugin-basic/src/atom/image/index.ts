import { BlockAtom, getPx, INodeInfo, SylApi, SylController, SylPlugin } from '@syllepsis/adapter';
import { DOMOutputSpecArray, Node, Node as ProsemirrorNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { addAttrsByConfig, getFixSize, getFromDOMByConfig, isObjectURL, setDOMAttrByConfig } from '../../utils';
import { ImageAttrs, ImageProps, TUploadDataType } from './types';
import {
  checkDomain,
  constructAttrs,
  correctSize,
  getImageFileList,
  getInputImageFiles,
  transformBlobFromObjectURL,
} from './utils';

const PLUGIN_NAME = 'image';
let maxWidth = window.innerWidth - 40;

const BASE_CONFIG: ImageProps = {
  uploader: () => Promise.resolve(''),
  uploadBeforeInsert: false,
  placeholder: '',
  uploadType: 'blob' as const,
  listenDrop: true,
  listenPaste: true,
  maxLength: 20,
  uploadMaxWidth: 375,
};
// parse the DOM of image which generated by the the ImagePlugin
const parseSylDOM = (dom: HTMLElement, fixClass: string, captionClass: string) => {
  const image = (dom.querySelector('img') as HTMLImageElement) || null;
  const caption = dom.querySelector(captionClass) as HTMLInputElement | HTMLParagraphElement | null;
  const fixer = dom.querySelector(fixClass);

  const alt = (caption && (caption.innerText || (caption as HTMLInputElement).value)) || '';
  const src = (image && image.src) || '';
  const width = image.width;
  const height = image.height;
  const name = image.getAttribute('name') || '';

  let align: ImageAttrs['align'] = dom.getAttribute('align') as ImageAttrs['align'];
  if (!align && fixer) {
    const className = fixer.className;
    if (className.includes('left')) align = 'left';
    else if (className.includes('right')) align = 'right';
  }
  return { src, alt, width, height, align, name } as ImageAttrs;
};

const uploadImg = async (editor: SylApi, src: string, fileName: string, config: ImageProps) => {
  let res: TUploadDataType = src;
  const { uploader, uploadType, onUploadError, deleteFailedUpload, uploadBeforeInsert } = config;
  if (!uploader) throw new Error('Must provide uploader!');
  if (isObjectURL(src)) res = await transformBlobFromObjectURL(src);

  if (typeof res !== 'string' && uploadType === 'file') {
    res = new File([res as Blob], fileName, { type: res?.type });
  }
  try {
    const uploadRes = await uploader(res, {
      src,
    });
    return typeof uploadRes === 'string' ? { src: uploadRes || src } : uploadRes;
  } catch (err) {
    if (deleteFailedUpload && uploadBeforeInsert !== true) {
      const nodeInfos = editor.getExistNodes(PLUGIN_NAME);
      nodeInfos.some(({ node, pos }) => {
        if (node.attrs.src === src) {
          editor.deleteCard(pos);
          return true;
        }
      });
    }
    if (onUploadError) onUploadError(res, err);
    else throw err;
  }
};

const insertImageInEditor = (
  editor: SylApi,
  dataInfos: { image?: HTMLImageElement; attrs?: { src: string; [key: string]: any } }[],
  pos: number,
  config: Partial<ImageProps>,
) => {
  const insertNodes = { type: 'doc', content: [] as INodeInfo[] };
  dataInfos.forEach(({ image, attrs }) => {
    if (!image || !attrs) return;
    const imageAttrs: Partial<ImageAttrs> = {
      width: config.uploadMaxWidth ? Math.min(image.naturalWidth, config.uploadMaxWidth) : image.naturalWidth,
      name: image.getAttribute('name') || '',
      alt: '',
      align: 'center',
      ...attrs,
    };
    insertNodes.content.push({ type: PLUGIN_NAME, attrs: imageAttrs });
  });
  if (insertNodes.content.length) editor.insert(insertNodes, pos);
};

// get the picture file and judge whether to upload it in advance
const insertImageWithFiles = async (editor: SylApi, files: File[], config: Partial<ImageProps>) => {
  const results = await Promise.all(
    files.map(
      f =>
        new Promise(resolve => {
          const url = window.URL.createObjectURL(f);
          let attrs: undefined | { src: string } = { src: url };
          const image = document.createElement('img');

          image.onload = async () => {
            if (config.uploadBeforeInsert) {
              attrs = await uploadImg(editor, url, f.name, config);
              if (!attrs) resolve({});
            }
            resolve({ attrs, image });
          };
          image.onerror = async e => {
            const { onUploadError } = config;
            onUploadError && onUploadError(f, e as Event);
            resolve({});
          };

          image.src = attrs.src;
          image.setAttribute('name', f.name);
        }) as Promise<{ image?: HTMLImageElement; attrs?: { src: string } }>,
    ),
  );

  insertImageInEditor(editor, results, editor.view.state.selection.from, config);
};

interface IUpdateImageProps {
  getPos: () => number;
  attrs: ImageAttrs;
  state: any;
}

const updateImageUrl = async (editor: SylApi, props: IUpdateImageProps, config: ImageProps) => {
  maxWidth = editor.view.dom.scrollWidth - 40;

  const { src, name } = props.attrs;
  if (props.state === undefined) props.state = {};
  const state = props.state;
  try {
    // upload state, only one upload request is allowed in the same instance at the same time
    if (state.uploading || (!isObjectURL(src) && checkDomain(src, config))) {
      const newAttrs = await correctSize(props.attrs);
      if ((Object.keys(newAttrs) as Array<keyof typeof newAttrs>).some(key => newAttrs[key] !== props.attrs[key])) {
        editor.updateCardAttrs(props.getPos(), newAttrs);
      }
      return;
    }

    state.uploading = true;
    const attrs = await uploadImg(editor, src, name, config);
    state.uploading = false;
    if (!attrs) return;

    const imgSize = await correctSize({ ...props.attrs, ...attrs });
    const imageAttrs = constructAttrs({ ...props.attrs, ...imgSize }, attrs);

    if (src !== attrs.src) {
      editor.updateCardAttrs(props.getPos(), imageAttrs);
    }
  } catch (err) {
    state.uploading = false;
  }
};

const createImageFileInput = (editor: SylApi, config: ImageProps) => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = config.accept || 'image/*';
  input.style.display = 'none';
  input.onchange = (e: any) => {
    const files = getInputImageFiles(e);
    insertImageWithFiles(editor, files, config);
    input.value = '';
  };

  return input;
};
class ImageController extends SylController<ImageProps> {
  public fileInput: HTMLInputElement;

  public toolbar = {
    className: 'image',
    tooltip: 'image',
    icon: '' as any,
    handler: () => this.fileInput.click(),
  };

  constructor(editor: SylApi, props: ImageProps) {
    super(editor, props);
    if (Object.keys(props).length) this.props = { ...BASE_CONFIG, ...props };
    this.fileInput = createImageFileInput(editor, this.props);
    editor.root.appendChild(this.fileInput);
  }

  public command = {
    insertImages: (editor: SylApi, files: File[]) => insertImageWithFiles(editor, files, this.props),
    updateImageUrl: (editor: SylApi, props: IUpdateImageProps) => updateImageUrl(editor, props, this.props),
    getConfiguration: () => this.props,
  };

  public eventHandler = {
    handleClickOn(
      editor: SylApi,
      view: EditorView,
      pos: number,
      node: ProsemirrorNode,
      nodePos: number,
      event: MouseEvent,
    ) {
      if (node.type.name === PLUGIN_NAME) {
        const caption = (event.target as HTMLElement).closest('input');
        if (caption) {
          if (caption) caption.focus();
          const newTextSelection = TextSelection.create(view.state.doc, nodePos);
          view.dispatch(view.state.tr.setSelection(newTextSelection));
          return true;
        }
        // when the currently selected image is a picture, but the system behaves as a cursor, correct the selection.(real is 'Range')
        const { state, dispatch } = view;
        const curSelection = window.getSelection();
        if (curSelection && curSelection.type === 'Caret') {
          dispatch(state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
          return true;
        }
        return false;
      }
      return false;
    },
    handlePaste: (editor: SylApi, view: EditorView, e: Event) => {
      const event = e as ClipboardEvent;
      if ((this.props && !this.props.listenPaste) || !event.clipboardData) {
        return false;
      }
      const files = getImageFileList(event.clipboardData.files);
      if (!files.length || event.clipboardData.getData('text/html')) {
        return false;
      }
      editor.command.image!.insertImages(files);
      return true;
    },
    handleDOMEvents: {
      drop: (editor: SylApi, view: EditorView, e: Event) => {
        const event = e as DragEvent;

        if (view.dragging || (this.props && !this.props.listenDrop) || !event.dataTransfer) {
          return false;
        }
        const files: File[] = getImageFileList(event.dataTransfer.files);
        if (!files.length) return false;
        editor.command.image!.insertImages(files);
        e.preventDefault();
        return true;
      },
    },
  };
}

class Image extends BlockAtom<ImageAttrs> {
  public props: ImageProps;
  public name = PLUGIN_NAME;
  public traceSelection = false;

  constructor(editor: SylApi, props: ImageProps) {
    super(editor, props);
    addAttrsByConfig(props.addAttributes, this);
    this.props = props;
    if (this.props.disableAlign) {
      const { align, ...rest } = this.attrs;
      // @ts-ignore
      this.attrs = rest;
    }
  }

  public parseDOM = [
    {
      tag: 'div.syl-image-wrapper',
      getAttrs: (dom: HTMLElement) => parseSylDOM(dom, '.syl-image-fixer', '.syl-image-caption'),
    },
    {
      tag: 'img',
      getAttrs: (dom: HTMLImageElement) => {
        if (!dom.src) return false;

        let width = getPx(dom.style.width || dom.getAttribute('width') || '', 16);
        let height = getPx(dom.style.height || dom.getAttribute('height') || '', 16);

        if (!width || isNaN(width)) width = 0;
        if (!height || isNaN(height)) height = 0;

        if (width > maxWidth) {
          if (height) height = height / (width / maxWidth);
          width = maxWidth;
        }

        const formattedAttrs = {
          src: dom.getAttribute('src') || '',
          alt: dom.getAttribute('alt') || '',
          name: dom.getAttribute('name') || '',
          align: (dom.getAttribute('align') || 'center') as any,
          width,
          height,
        };
        getFromDOMByConfig(this.props.addAttributes, dom, formattedAttrs);

        return formattedAttrs;
      },
    },
  ];
  public toDOM = (node: Node) => {
    const { align, width, height, ...attrs } = node.attrs;
    setDOMAttrByConfig(this.props.addAttributes, node, attrs);

    if (width) attrs.width = getFixSize(width);
    if (height) attrs.height = getFixSize(height);

    const renderSpec = ['img', attrs] as DOMOutputSpecArray;
    if (this.inline) return renderSpec;

    const alignAttrs = this.props.disableAlign ? {} : { align: align || 'center' };
    return [
      'div',
      { class: 'syl-image-wrapper', ...alignAttrs },
      renderSpec,
      attrs.alt && ['p', { class: 'syl-image-caption' }, attrs.alt],
    ] as DOMOutputSpecArray;
  };

  public attrs = {
    src: {
      default: '',
    },
    alt: {
      default: '',
    },
    name: {
      default: '',
    },
    width: {
      default: 0,
    },
    height: {
      default: 0,
    },
    align: {
      default: 'center' as const,
    },
  };
}

class ImagePlugin extends SylPlugin<ImageProps> {
  public name = PLUGIN_NAME;
  public Controller = ImageController;
  public Schema = Image;
}

export { Image, ImageAttrs, ImageController, ImagePlugin, ImageProps };
