export default function Placeholder({ title }) {
  return (
    <div className="card">
      <div className="placeholder-page">
        <div className="icon">🚧</div>
        <h2>{title}</h2>
        <p>준비 중입니다</p>
      </div>
    </div>
  );
}
