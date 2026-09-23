"""
Wan 2.2 Animate Replace Space (skeleton).

Deploy as a Gradio ZeroGPU Space on Hugging Face Pro.
Wire Wan2.2-Animate-14B replace in run_swap().
Contract: template video + still in, mp4 out.
"""
import gradio as gr

try:
    import spaces
except ImportError:
    class spaces:
        @staticmethod
        def GPU(duration=180):
            def wrap(fn):
                return fn
            return wrap


@spaces.GPU(duration=180)
def run_swap(template_video, face_image):
    if template_video is None or face_image is None:
        raise gr.Error("Need one template clip and one still.")
    return template_video


demo = gr.Interface(
    fn=run_swap,
    inputs=[
        gr.Video(label="Template clip"),
        gr.Image(type="filepath", label="Still photo"),
    ],
    outputs=gr.Video(label="You in the template"),
    title="Wan 2.2 template swap",
    api_name="swap",
)

if __name__ == "__main__":
    demo.launch()
